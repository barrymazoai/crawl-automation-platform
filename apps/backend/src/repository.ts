import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { JobStage, NodeCapability } from "@crawl-automation/contracts";
import { classifyUrl } from "@crawl-automation/runtime";
import { CronExpressionParser } from "cron-parser";

function leaseHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
function leaseToken() { return randomBytes(32).toString("base64url"); }
function iso(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
function nextCronDate(expression: string, timezone: string, currentDate = new Date()) {
  return CronExpressionParser.parse(expression, { currentDate, tz: timezone }).next().toDate();
}

export class PipelineRepository {
  constructor(private pool: Pool, private leaseTtlSeconds = 120) {}

  private async transaction<T>(action: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try { await client.query("begin"); const value = await action(client); await client.query("commit"); return value; }
    catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  private async idempotent<T>(client: PoolClient, scope: string, key: string, payload: unknown, action: () => Promise<T>) {
    if (!key) throw new Error("缺少 Idempotency-Key");
    const fingerprint = createHash("sha256").update(JSON.stringify(payload ?? {})).digest("hex");
    const existing = (await client.query("select fingerprint,response from pipeline_idempotency where scope=$1 and idempotency_key=$2 for update", [scope, key])).rows[0];
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("Idempotency-Key 与原请求不一致");
      return existing.response as T;
    }
    const response = await action();
    await client.query("insert into pipeline_idempotency(scope,idempotency_key,fingerprint,response) values($1,$2,$3,$4::jsonb)", [scope, key, fingerprint, JSON.stringify(response)]);
    return response;
  }

  async summary() {
    const [runs, nodes, jobs] = await Promise.all([
      this.pool.query(`select count(*)::int total,
        count(*) filter(where status in ('queued','active','retry_wait'))::int active,
        count(*) filter(where status='needs_review')::int needs_review,
        count(*) filter(where status='failed')::int failed,
        count(*) filter(where status='completed')::int completed from pipeline_run`),
      this.pool.query(`select count(*)::int total,count(*) filter(where last_seen_at>now()-interval '90 seconds')::int online from pipeline_node`),
      this.pool.query("select state,count(*)::int count from pipeline_job group by state"),
    ]);
    const r = runs.rows[0]; const n = nodes.rows[0];
    return {
      runs: { total: r.total, active: r.active, needsReview: r.needs_review, failed: r.failed, completed: r.completed },
      nodes: { total: n.total, online: n.online },
      jobs: Object.fromEntries(jobs.rows.map((row) => [row.state, row.count])),
    };
  }

  classify(rawUrls: string[]) {
    return rawUrls.map((raw) => {
      try { return classifyUrl(raw); }
      catch { return { url: raw.trim(), host: "", type: "dtc_browser" as const, adapter: null, supported: false, reason: "网址格式无效" }; }
    });
  }

  async createRuns(input: { urls: string[]; mode: "one_off" | "recurring"; scheduleCron?: string | null | undefined; scheduleTimezone: string }) {
    const classifications = this.classify(input.urls);
    const rejected = classifications.filter((item) => !item.supported);
    const createdIds: string[] = [];
    for (const item of classifications.filter((entry) => entry.supported)) {
      const runId = randomUUID();
      await this.transaction(async (client) => {
        const sourceId = randomUUID();
        const nextRunAt = input.mode === "recurring" && input.scheduleCron ? nextCronDate(input.scheduleCron, input.scheduleTimezone) : null;
        const source = (await client.query(
          `insert into pipeline_source(id,url,origin,source_type,adapter,mode,schedule_cron,schedule_timezone,next_run_at)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9)
           on conflict(origin,mode) do update set url=excluded.url,source_type=excluded.source_type,adapter=excluded.adapter,
             schedule_cron=excluded.schedule_cron,schedule_timezone=excluded.schedule_timezone,next_run_at=excluded.next_run_at,enabled=true,updated_at=now()
           returning id`,
          [sourceId, item.url, new URL(item.url).origin, item.type, item.adapter, input.mode, input.scheduleCron ?? null, input.scheduleTimezone, nextRunAt],
        )).rows[0];
        await client.query("insert into pipeline_run(id,source_id) values($1,$2)", [runId, source.id]);
        const captureId = await this.insertJobDag(client, runId, item);
        await this.event(client, runId, captureId, "run.created", "admin", item);
        return runId;
      });
      createdIds.push(runId);
    }
    const created = (await Promise.all(createdIds.map((id) => this.listRuns(undefined, 1, id)))).flat();
    return { created, rejected };
  }

  async enqueueDueRecurring(now = new Date()) {
    return this.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext('pipeline-recurring-scheduler'))");
      const sources = (await client.query(`select * from pipeline_source where enabled=true and mode='recurring'
        and schedule_cron is not null and next_run_at<= $1 order by next_run_at for update`, [now])).rows;
      const created: string[] = [];
      for (const source of sources) {
        const active = (await client.query("select 1 from pipeline_run where source_id=$1 and status not in ('completed','failed','abandoned') limit 1", [source.id])).rowCount;
        if (!active) {
          const runId = randomUUID(); await client.query("insert into pipeline_run(id,source_id) values($1,$2)", [runId, source.id]);
          const captureId = await this.insertJobDag(client, runId, { url: source.url, type: source.source_type, adapter: source.adapter });
          await this.event(client, runId, captureId, "run.scheduled", "scheduler", { scheduledFor: source.next_run_at }); created.push(runId);
        }
        await client.query("update pipeline_source set next_run_at=$2,updated_at=now() where id=$1", [source.id, nextCronDate(source.schedule_cron, source.schedule_timezone, now)]);
      }
      return created;
    });
  }

  async listRuns(status?: string, limit = 100, id?: string) {
    const values: unknown[] = [];
    const where = [];
    if (status) { values.push(status); where.push(`r.status=$${values.length}`); }
    if (id) { values.push(id); where.push(`r.id=$${values.length}`); }
    values.push(limit);
    const result = await this.pool.query(
      `select r.id,s.url,s.source_type,s.adapter,r.status,r.item_count,r.open_review_count,r.created_at,r.updated_at,
        coalesce(jsonb_object_agg(j.stage,j.state) filter(where j.id is not null),'{}'::jsonb) stages
       from pipeline_run r join pipeline_source s on s.id=r.source_id left join pipeline_job j on j.run_id=r.id
       ${where.length ? `where ${where.join(" and ")}` : ""}
       group by r.id,s.url,s.source_type,s.adapter order by r.created_at desc limit $${values.length}`,
      values,
    );
    return result.rows.map((row) => ({
      id: row.id, url: row.url, sourceType: row.source_type, adapter: row.adapter, status: row.status,
      stages: row.stages, itemCount: row.item_count, openReviews: row.open_review_count,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    }));
  }

  async getRun(id: string) {
    const run = (await this.listRuns(undefined, 1, id))[0];
    if (!run) throw new Error("任务不存在");
    const [jobs, artifacts, reviews, events] = await Promise.all([
      this.pool.query("select id,stage,state,attempt,max_attempts,required_capability,payload,output,error_code,error_message,leased_by,lease_expires_at,created_at,updated_at from pipeline_job where run_id=$1 order by created_at", [id]),
      this.pool.query("select id,job_id,kind,file_name,content_type,sha256,byte_size,status,created_at,deleted_at from pipeline_artifact where run_id=$1 order by created_at", [id]),
      this.pool.query("select * from pipeline_review where run_id=$1 order by created_at", [id]),
      this.pool.query("select * from pipeline_event where run_id=$1 order by id desc limit 300", [id]),
    ]);
    return { run, jobs: jobs.rows, artifacts: artifacts.rows, reviews: reviews.rows, events: events.rows };
  }

  async listNodes() {
    const rows = (await this.pool.query(`select n.*,
      (select count(*)::int from pipeline_job j where j.leased_by=n.id and j.state in ('leased','running') and j.lease_expires_at>now()) active_jobs
      from pipeline_node n order by n.name`)).rows;
    const now = Date.now();
    return rows.map((row) => {
      const age = now - new Date(row.last_seen_at).getTime();
      const status: "online" | "stale" | "offline" = age <= 90_000 ? "online" : age <= 300_000 ? "stale" : "offline";
      return { id: row.id, name: row.name, platform: row.platform, version: row.version, capabilities: row.capabilities,
        maxConcurrency: row.max_concurrency, activeJobs: row.active_jobs, status, lastSeenAt: iso(row.last_seen_at) };
    });
  }

  async registerNode(input: { nodeId: string; name: string; platform: string; version: string; capabilities: NodeCapability[]; maxConcurrency: number }, allowed: string[]) {
    if (input.capabilities.some((capability) => !allowed.includes(capability))) throw new Error("节点 Token 不允许声明该 capability");
    await this.pool.query(`insert into pipeline_node(id,name,platform,version,capabilities,max_concurrency)
      values($1,$2,$3,$4,$5,$6) on conflict(id) do update set name=excluded.name,platform=excluded.platform,version=excluded.version,
      capabilities=excluded.capabilities,max_concurrency=excluded.max_concurrency,last_seen_at=now(),updated_at=now()`,
    [input.nodeId, input.name, input.platform, input.version, input.capabilities, input.maxConcurrency]);
    return { success: true };
  }

  async heartbeatNode(nodeId: string, activeJobIds: string[]) {
    await this.pool.query("update pipeline_node set last_seen_at=now(),metadata=jsonb_set(metadata,'{reportedActiveJobs}',$2::jsonb),updated_at=now() where id=$1", [nodeId, JSON.stringify(activeJobIds)]);
    return { success: true, serverTime: new Date().toISOString() };
  }

  async claim(nodeId: string, capabilities: NodeCapability[]) {
    return this.transaction(async (client) => {
      await client.query(`update pipeline_job set state=case when attempt>=max_attempts then 'failed' else 'retry_wait' end,
        available_at=now(),leased_by=null,lease_token_hash=null,lease_expires_at=null,error_code='lease_expired',error_message='node lease expired',updated_at=now()
        where state in ('leased','running') and lease_expires_at<=now()`);
      const node = (await client.query("select * from pipeline_node where id=$1 for update", [nodeId])).rows[0];
      if (!node) throw new Error("节点尚未注册");
      const allowed = capabilities.filter((value) => node.capabilities.includes(value));
      const active = Number((await client.query("select count(*) count from pipeline_job where leased_by=$1 and state in ('leased','running') and lease_expires_at>now()", [nodeId])).rows[0].count);
      if (active >= node.max_concurrency || allowed.length === 0) return null;
      const job = (await client.query(
        `select j.*,r.status run_status,s.url,s.source_type,s.adapter from pipeline_job j
         join pipeline_run r on r.id=j.run_id join pipeline_source s on s.id=r.source_id
         where j.state in ('queued','retry_wait') and j.available_at<=now() and j.required_capability=any($1::text[])
           and r.status not in ('needs_review','failed','completed','abandoned')
           and not exists(select 1 from pipeline_job dependency where dependency.id=any(j.depends_on) and dependency.state<>'completed')
         order by j.created_at for update of j skip locked limit 1`, [allowed],
      )).rows[0];
      if (!job) return null;
      const token = leaseToken();
      await client.query(`update pipeline_job set state='leased',attempt=attempt+1,leased_by=$2,lease_token_hash=$3,
        lease_expires_at=now()+make_interval(secs=>$4),updated_at=now() where id=$1`, [job.id, nodeId, leaseHash(token), this.leaseTtlSeconds]);
      await client.query("update pipeline_run set status='active',updated_at=now() where id=$1 and status in ('queued','retry_wait')", [job.run_id]);
      await this.event(client, job.run_id, job.id, "job.claimed", nodeId, { capability: job.required_capability });
      const artifacts = (await client.query(`select a.id,a.kind,a.file_name,a.content_type,a.sha256,a.byte_size,a.status
        from pipeline_artifact a join pipeline_job source_job on source_job.id=a.job_id
        where source_job.id=any($1::uuid[]) and a.status='ready' order by a.created_at`, [job.depends_on])).rows;
      return { job: { id: job.id, runId: job.run_id, stage: job.stage, payload: job.payload, source: { url: job.url, type: job.source_type, adapter: job.adapter }, inputArtifacts: artifacts }, lease: { token, expiresAt: new Date(Date.now() + this.leaseTtlSeconds * 1000).toISOString() } };
    });
  }

  private async requireLease(client: PoolClient, jobId: string, token: string) {
    const job = (await client.query("select * from pipeline_job where id=$1 for update", [jobId])).rows[0];
    if (!job || job.lease_token_hash !== leaseHash(token) || new Date(job.lease_expires_at) <= new Date()) throw new Error("租约无效或已过期");
    return job;
  }

  async start(jobId: string, token: string) {
    return this.transaction(async (client) => {
      const job = await this.requireLease(client, jobId, token);
      await client.query("update pipeline_job set state='running',started_at=coalesce(started_at,now()),updated_at=now() where id=$1", [jobId]);
      await this.event(client, job.run_id, jobId, "job.started", job.leased_by, {});
      return { success: true };
    });
  }

  async renew(jobId: string, token: string) {
    return this.transaction(async (client) => {
      await this.requireLease(client, jobId, token);
      const expiresAt = new Date(Date.now() + this.leaseTtlSeconds * 1000);
      await client.query("update pipeline_job set lease_expires_at=$2,updated_at=now() where id=$1", [jobId, expiresAt]);
      return { expiresAt: expiresAt.toISOString() };
    });
  }

  async complete(jobId: string, token: string, output: unknown, idempotencyKey: string) {
    return this.transaction(async (client) => {
      return this.idempotent(client, `complete:${jobId}`, idempotencyKey, output, async () => {
        const job = await this.requireLease(client, jobId, token);
        await client.query(`update pipeline_job set state='completed',output=$2::jsonb,completed_at=now(),leased_by=null,
          lease_token_hash=null,lease_expires_at=null,error_code=null,error_message=null,updated_at=now() where id=$1`, [jobId, JSON.stringify(output ?? {})]);
        if (job.stage === "capture") {
          const itemCount = Number((output as any)?.itemCount ?? 0);
          await client.query("update pipeline_run set item_count=$2,updated_at=now() where id=$1", [job.run_id, itemCount]);
        }
        if (job.stage === "cleanup") await client.query("update pipeline_run set status='completed',updated_at=now() where id=$1", [job.run_id]);
        await this.event(client, job.run_id, jobId, "job.completed", job.leased_by, output ?? {});
        return { success: true };
      });
    });
  }

  async fail(jobId: string, token: string, input: { code: string; message: string; retryable: boolean; needsReview?: boolean | undefined }, idempotencyKey: string) {
    return this.transaction(async (client) => {
      return this.idempotent(client, `fail:${jobId}`, idempotencyKey, input, async () => {
      const job = await this.requireLease(client, jobId, token);
      if (input.needsReview) {
        const reviewId = randomUUID();
        await client.query("update pipeline_job set state='needs_review',leased_by=null,lease_token_hash=null,lease_expires_at=null,error_code=$2,error_message=$3,updated_at=now() where id=$1", [jobId, input.code, input.message]);
        await client.query("insert into pipeline_review(id,run_id,job_id,reason_code,reason_message) values($1,$2,$3,$4,$5)", [reviewId, job.run_id, jobId, input.code, input.message]);
        await client.query("update pipeline_run set status='needs_review',open_review_count=open_review_count+1,error_code=$2,error_message=$3,updated_at=now() where id=$1", [job.run_id, input.code, input.message]);
      } else if (input.retryable && job.attempt < job.max_attempts) {
        const delaySeconds = Math.min(300, 2 ** job.attempt * 5);
        await client.query(`update pipeline_job set state='retry_wait',available_at=now()+make_interval(secs=>$2),leased_by=null,
          lease_token_hash=null,lease_expires_at=null,error_code=$3,error_message=$4,updated_at=now() where id=$1`, [jobId, delaySeconds, input.code, input.message]);
        await client.query("update pipeline_run set status='retry_wait',error_code=$2,error_message=$3,updated_at=now() where id=$1", [job.run_id, input.code, input.message]);
      } else {
        await client.query("update pipeline_job set state='failed',leased_by=null,lease_token_hash=null,lease_expires_at=null,error_code=$2,error_message=$3,updated_at=now() where id=$1", [jobId, input.code, input.message]);
        await client.query("update pipeline_run set status='failed',error_code=$2,error_message=$3,updated_at=now() where id=$1", [job.run_id, input.code, input.message]);
      }
      await this.event(client, job.run_id, jobId, "job.failed", job.leased_by, input);
      return { success: true };
      });
    });
  }

  async createArtifact(jobId: string, token: string, input: { kind: string; fileName: string; contentType: string; sha256: string; byteSize: number }, idempotencyKey: string) {
    return this.transaction(async (client) => {
      return this.idempotent(client, `artifact:${jobId}`, idempotencyKey, input, async () => {
      const job = await this.requireLease(client, jobId, token); const id = randomUUID();
      const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const bucketKey = `runs/${job.run_id}/${jobId}/${id}-${safeName}`;
      await client.query(`insert into pipeline_artifact(id,run_id,job_id,kind,bucket_key,file_name,content_type,sha256,byte_size)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, job.run_id, jobId, input.kind, bucketKey, safeName, input.contentType, input.sha256, input.byteSize]);
      return { id, runId: job.run_id, jobId, bucketKey, ...input };
      });
    });
  }

  async getArtifact(id: string) {
    const artifact = (await this.pool.query("select * from pipeline_artifact where id=$1", [id])).rows[0];
    if (!artifact) throw new Error("产物不存在");
    return artifact;
  }
  async listRunArtifacts(runId: string) {
    return (await this.pool.query("select * from pipeline_artifact where run_id=$1 and status<>'deleted' order by created_at", [runId])).rows;
  }
  async confirmArtifact(id: string, jobId: string, token: string) {
    return this.transaction(async (client) => {
      await this.requireLease(client, jobId, token);
      const artifact = (await client.query("update pipeline_artifact set status='ready' where id=$1 and job_id=$2 returning *", [id, jobId])).rows[0];
      if (!artifact) throw new Error("产物与 Job 不匹配");
      return artifact;
    });
  }
  async markArtifactDeleted(id: string, failed = false) {
    await this.pool.query(`update pipeline_artifact set status=$2,deleted_at=case when $2='deleted' then now() else deleted_at end where id=$1`, [id, failed ? "delete_failed" : "deleted"]);
  }

  async listReviews(status = "open") {
    const rows = (await this.pool.query(`select rv.*,s.url from pipeline_review rv join pipeline_run r on r.id=rv.run_id
      join pipeline_source s on s.id=r.source_id where rv.status=$1 order by rv.created_at`, [status])).rows;
    return rows.map((row) => ({ id: row.id, runId: row.run_id, jobId: row.job_id, url: row.url, reasonCode: row.reason_code,
      reasonMessage: row.reason_message, status: row.status, createdAt: iso(row.created_at) }));
  }

  async resolveReview(id: string, action: "retry" | "resume" | "abandon", resolution: string) {
    return this.transaction(async (client) => {
      const review = (await client.query("select * from pipeline_review where id=$1 and status='open' for update", [id])).rows[0];
      if (!review) throw new Error("复核项不存在或已处理");
      await client.query("update pipeline_review set status=$2,resolution=$3,resolved_at=now() where id=$1", [id, action === "abandon" ? "abandoned" : "resolved", resolution]);
      if (action === "abandon") {
        await client.query("update pipeline_run set status='abandoned',open_review_count=greatest(open_review_count-1,0),updated_at=now() where id=$1", [review.run_id]);
      } else {
        await client.query("update pipeline_job set state='queued',available_at=now(),error_code=null,error_message=null,updated_at=now() where id=$1", [review.job_id]);
        await client.query("update pipeline_run set status='queued',open_review_count=greatest(open_review_count-1,0),error_code=null,error_message=null,updated_at=now() where id=$1", [review.run_id]);
      }
      return { success: true };
    });
  }

  async channelStats() {
    const rows = (await this.pool.query(`select s.adapter,count(r.id)::int run_count,
      count(r.id) filter(where r.status='completed')::int success_count,count(r.id) filter(where r.status='failed')::int failure_count,
      max(r.updated_at) last_run_at,(array_agg(r.error_message order by r.updated_at desc) filter(where r.error_message is not null))[1] last_error
      from pipeline_source s left join pipeline_run r on r.source_id=s.id where s.source_type='sales_channel' group by s.adapter`)).rows;
    const map = new Map(rows.map((row) => [row.adapter, row]));
    return ["amazon", "gnc", "target", "whole_foods"].map((adapter) => {
      const row = map.get(adapter); const runCount = row?.run_count ?? 0; const successCount = row?.success_count ?? 0; const failureCount = row?.failure_count ?? 0;
      return { adapter, implemented: adapter === "amazon", enabled: adapter === "amazon", runCount, successCount, failureCount,
        successRate: runCount ? successCount / runCount : 0, lastRunAt: row?.last_run_at ? iso(row.last_run_at) : null, lastError: row?.last_error ?? null };
    });
  }

  private async insertJobDag(client: PoolClient, runId: string, item: { url: string; type: "dtc_browser" | "sales_channel"; adapter: "amazon" | null }) {
    const captureId = randomUUID(), ocrId = randomUUID(), normalizeId = randomUUID(), ingestId = randomUUID(), cleanupId = randomUUID();
    const jobs: Array<[string, JobStage, NodeCapability, string[], number, unknown]> = [
      [captureId, "capture", item.type === "sales_channel" ? "sales_channel" : "browser", [], 3, { url: item.url, sourceType: item.type, adapter: item.adapter }],
      [ocrId, "ocr", "ocr", [captureId], 2, { sourceJobId: captureId }],
      [normalizeId, "normalize", "normalize", [ocrId], 2, { sourceJobId: ocrId }],
      [ingestId, "ingest", "ingest", [normalizeId], 2, { sourceJobId: normalizeId }],
      [cleanupId, "cleanup", "cleanup", [ingestId], 5, { sourceJobId: ingestId }],
    ];
    for (const job of jobs) await client.query(
      `insert into pipeline_job(id,run_id,stage,required_capability,depends_on,max_attempts,payload)
       values($1,$2,$3,$4,$5::uuid[],$6,$7::jsonb)`,
      [job[0], runId, job[1], job[2], job[3], job[4], JSON.stringify(job[5])],
    );
    return captureId;
  }

  private event(client: PoolClient, runId: string, jobId: string | null, type: string, actor: string, payload: unknown) {
    return client.query("insert into pipeline_event(run_id,job_id,event_type,actor,payload) values($1,$2,$3,$4,$5::jsonb)", [runId, jobId, type, actor, JSON.stringify(payload ?? {})]);
  }
}
