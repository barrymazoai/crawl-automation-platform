import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type pg from "pg";
import { sha256 } from "@crawl-automation/v3-artifacts";
import { AmazonLinkBatchSchema, type AmazonLinkBatch } from "./amazon-link-batches.js";

// Session lock serializes pause/resume with a bounded dispatch, including remote Start.
// It is released automatically if the process/connection dies. No persisted runner lease.
const lockId = 73110324;
type Query = Pick<pg.PoolClient, "query">;
type Mode = "running" | "paused" | "draining" | "stopping";
export type QueueItem = { item_id: string; input: AmazonLinkBatch; request_id: string; attempt: number; state: string };
export type QueueInspection =
  | { status: "running" | "cleanup-pending"; reason?: string }
  | { status: "completed" | "review" | "interrupted"; proof: Record<string, unknown> };
export interface AmazonQueuePorts {
  /** Host health and cleanup interlock. Failure to read it denies new work. */
  canStart?(): Promise<boolean>;
  /** Acceptance is idempotent by requestId; delivery retains its one-shot Start rule. */
  submit(batch: AmazonLinkBatch): Promise<void>;
  inspect(batch: AmazonLinkBatch): Promise<QueueInspection>;
  /** Stop the exact execution tree. A stop acknowledgement is NOT settlement. */
  stop(batch: AmazonLinkBatch): Promise<void>;
}
export type QueueEvent = { event: string; requestId?: string; itemId?: string; code?: string };
export class QueueAdmissionRejected extends Error {}
const code = (e: unknown) => e instanceof Error && /^[A-Z][A-Z0-9_.]+$/.test(e.message) ? e.message.slice(0, 160) : "QUEUE.OPERATION_FAILED";

export class AmazonQueue {
  constructor(readonly pool: pg.Pool) {}
  /** No implicit resume, including after a restart or importing more work. */
  async status() {
    return (await this.pool.query(`SELECT c.*,
      (SELECT coalesce(jsonb_object_agg(state,n),'{}'::jsonb) FROM
        (SELECT state,count(*)::int n FROM amazon_queue_item GROUP BY state) s) AS counts,
      (SELECT count(*)::int FROM amazon_queue_item WHERE state='running' AND last_error IS NOT NULL) AS attention
      FROM amazon_queue_control c WHERE singleton`)).rows[0];
  }
  async locked<T>(work: (db: pg.PoolClient) => Promise<T>, wait = true): Promise<T | undefined> {
    const db = await this.pool.connect(); let held = false, destroy = false;
    try {
      if (wait) { await db.query("SELECT pg_advisory_lock($1)", [lockId]); held = true; }
      else held = (await db.query("SELECT pg_try_advisory_lock($1) AS held", [lockId])).rows[0].held;
      if (!held) return undefined;
      return await work(db);
    } finally {
      if (held) {
        try { await db.query("SELECT pg_advisory_unlock($1)", [lockId]); }
        catch { destroy = true; }
      }
      db.release(destroy);
    }
  }
  private async transaction<T>(db: pg.PoolClient, fn: () => Promise<T>) {
    await db.query("BEGIN");
    try { const value = await fn(); await db.query("COMMIT"); return value; }
    catch (e) { await db.query("ROLLBACK").catch(() => {}); throw e; }
  }
  async add(campaignId: string, batches: readonly unknown[]) {
    z.string().min(1).max(200).parse(campaignId);
    const parsed = batches.map(b => AmazonLinkBatchSchema.parse(b));
    return this.locked(db => this.transaction(db, async () => {
      let added = 0;
      for (const batch of parsed) for (const entry of batch.entries) {
        const itemId = sha256(Buffer.from(JSON.stringify([campaignId, batch.scope, entry.entry])));
        // Original request ID is provenance only. Claim creates the actual single-product request.
        const input = { ...batch, entries: [entry] };
        const result = await db.query(`INSERT INTO amazon_queue_item(item_id,campaign_id,input)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING item_id`, [itemId, campaignId, input]);
        if (!result.rowCount) {
          const old = (await db.query("SELECT input FROM amazon_queue_item WHERE item_id=$1", [itemId])).rows[0];
          if (!equal(old.input, input)) throw Error("QUEUE.IMPORT_CONFLICT");
        } else added++;
      }
      return { added };
    }));
  }
  async configure(ready: number, running: number) {
    for (const n of [ready, running]) z.number().int().min(1).max(1000).parse(n);
    return this.locked(async db => {
      await db.query("UPDATE amazon_queue_control SET ready_limit=$1,running_limit=$2,updated_at=clock_timestamp() WHERE singleton", [ready, running]);
      // Lowering the ceiling never cancels running work; trim only unstarted rows.
      await db.query(`UPDATE amazon_queue_item SET state='queued' WHERE item_id IN
        (SELECT item_id FROM amazon_queue_item WHERE state='ready' ORDER BY created_at,item_id OFFSET $1)`, [ready]);
    });
  }
  async pause(force = false, graceSeconds = 900) {
    z.number().int().min(0).max(86400).parse(graceSeconds);
    return this.locked(db => this.transaction(db, async () => {
      await db.query(`UPDATE amazon_queue_control SET mode=$1,
        force_after=CASE WHEN $1='draining' AND $2::int>0 THEN clock_timestamp()+make_interval(secs=>$2) ELSE NULL END,
        updated_at=clock_timestamp() WHERE singleton`, [force ? "stopping" : "draining", graceSeconds]);
      await db.query("UPDATE amazon_queue_item SET state='queued',updated_at=clock_timestamp() WHERE state='ready'");
      // Observe ongoing requests promptly even if their previous check was deferred.
      await db.query("UPDATE amazon_queue_item SET next_check_at=clock_timestamp() WHERE state='running'");
    }));
  }
  async resume() {
    return this.locked(async db => {
      const c = await this.control(db);
      if (c.mode === "stopping" && (await db.query("SELECT 1 FROM amazon_queue_item WHERE state='running' LIMIT 1")).rowCount)
        throw Error("QUEUE.CLEANUP_PENDING");
      await db.query("UPDATE amazon_queue_control SET mode='running',force_after=NULL,updated_at=clock_timestamp() WHERE singleton");
    });
  }
  async requeue(ids: readonly string[]) {
    const selected = z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(10000).parse(ids);
    return this.locked(db => this.transaction(db, async () => {
      const rows = (await db.query("SELECT item_id,state FROM amazon_queue_item WHERE item_id=ANY($1) FOR UPDATE", [selected])).rows;
      if (rows.length !== new Set(selected).size || rows.some(r => !["completed", "review"].includes(r.state))) throw Error("QUEUE.REQUEUE_NOT_SETTLED");
      await db.query(`UPDATE amazon_queue_item SET state='queued',request_id=NULL,last_error=NULL,
        next_check_at=clock_timestamp(),updated_at=clock_timestamp() WHERE item_id=ANY($1)`, [selected]);
      return { requeued: rows.length };
    }));
  }
  async control(db: Query): Promise<{ mode: Mode; ready_limit: number; running_limit: number }> {
    await db.query(`UPDATE amazon_queue_control SET mode='stopping',force_after=NULL,updated_at=clock_timestamp()
      WHERE singleton AND mode='draining' AND force_after<=clock_timestamp()
      AND EXISTS(SELECT 1 FROM amazon_queue_item WHERE state='running')`);
    return (await db.query("SELECT * FROM amazon_queue_control WHERE singleton")).rows[0];
  }
  async fill(db: Query) {
    const c = await this.control(db);
    if (c.mode !== "running") return;
    await db.query(`UPDATE amazon_queue_item SET state='ready',updated_at=clock_timestamp() WHERE item_id IN (
      SELECT item_id FROM amazon_queue_item WHERE state='queued' AND next_check_at<=clock_timestamp()
      ORDER BY created_at,item_id LIMIT greatest(0,$1-(SELECT count(*)::int FROM amazon_queue_item WHERE state='ready')))`, [c.ready_limit]);
  }
  async claim(db: pg.PoolClient): Promise<QueueItem | null> {
    return this.transaction(db, async () => {
      const c = await this.control(db);
      if (c.mode !== "running") return null;
      const n = (await db.query("SELECT count(*)::int n FROM amazon_queue_item WHERE state='running'")).rows[0].n;
      if (n >= c.running_limit) return null;
      const row = (await db.query("SELECT * FROM amazon_queue_item WHERE state='ready' ORDER BY created_at,item_id LIMIT 1 FOR UPDATE")).rows[0];
      if (!row) return null;
      const batch = AmazonLinkBatchSchema.parse({ ...row.input, requestId: randomUUID() });
      await db.query("INSERT INTO amazon_link_batch(request_id,record) VALUES($1,$2)", [batch.requestId, batch]);
      await db.query("INSERT INTO amazon_queue_attempt(request_id,item_id,attempt) VALUES($1,$2,$3)", [batch.requestId, row.item_id, row.attempt + 1]);
      return (await db.query(`UPDATE amazon_queue_item SET state='running',attempt=attempt+1,request_id=$2,
        last_error=NULL,next_check_at=clock_timestamp(),updated_at=clock_timestamp() WHERE item_id=$1 RETURNING *`, [row.item_id, batch.requestId])).rows[0];
    });
  }
  async settle(db: pg.PoolClient, item: QueueItem, result: Extract<QueueInspection, { proof: unknown }>) {
    await this.transaction(db, async () => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('amazon-queue-attempt:' || $1,0))", [item.request_id]);
      await db.query("SELECT request_id FROM amazon_queue_attempt WHERE request_id=$1 FOR UPDATE", [item.request_id]);
      if (result.proof.kind === "never-started") {
        if ((await db.query("SELECT 1 FROM workflow_delivery WHERE request_id=$1", [item.request_id])).rowCount) throw Error("QUEUE.START_INTENT_EXISTS");
        await db.query("DELETE FROM source_submission_guard WHERE request_id=$1", [item.request_id]);
      }
      const changed = await db.query(`UPDATE amazon_queue_attempt SET outcome=$2,proof=$3,settled_at=clock_timestamp()
        WHERE request_id=$1 AND outcome='running' RETURNING request_id`, [item.request_id, result.status, result.proof]);
      if (!changed.rowCount) throw Error("QUEUE.ATTEMPT_CONFLICT");
      await db.query(`UPDATE amazon_queue_item SET state=$3,last_error=NULL,updated_at=clock_timestamp(),next_check_at=clock_timestamp()
        WHERE item_id=$1 AND request_id=$2 AND state='running'`, [item.item_id, item.request_id, result.status === "interrupted" ? "queued" : result.status]);
    });
  }
}

export class AmazonQueueRunner {
  private busy = false;
  constructor(readonly queue: AmazonQueue, readonly ports: AmazonQueuePorts, readonly report: (event: QueueEvent) => void = () => {}) {}
  private emit(event: QueueEvent) { try { this.report(event); } catch { /* logging cannot kill the queue */ } }
  private async visit(db: pg.PoolClient, item: QueueItem, dispatch: boolean) {
    const batch = AmazonLinkBatchSchema.parse({ ...item.input, requestId: item.request_id });
    try {
      const c = await this.queue.control(db);
      if (dispatch && c.mode === "running" && (!this.ports.canStart || await this.ports.canStart())) await this.ports.submit(batch);
      if (c.mode === "stopping") await this.ports.stop(batch);
      const result = await this.ports.inspect(batch);
      if ("proof" in result) {
        await this.queue.settle(db, item, result);
        this.emit({ event: "QUEUE_SETTLED", requestId: item.request_id });
      } else {
        await db.query(`UPDATE amazon_queue_item SET next_check_at=clock_timestamp()+make_interval(secs=>$2),last_error=$3
          WHERE item_id=$1`, [item.item_id, result.status === "cleanup-pending" ? 60 : 15, result.reason ?? null]);
      }
    } catch (error) {
      if (error instanceof QueueAdmissionRejected) {
        await this.queue.settle(db, item, { status: "review", proof: { kind: "never-started", code: code(error), requestId: item.request_id } });
        this.emit({ event: "QUEUE_ADMISSION_REVIEW", requestId: item.request_id, code: code(error) });
        return;
      }
      // Even if this write fails, the outer loop stays alive. The same durable attempt
      // is reconciled on restart; the runner never creates a replacement blindly.
      await db.query("UPDATE amazon_queue_item SET next_check_at=clock_timestamp()+interval '1 minute',last_error=$2 WHERE item_id=$1", [item.item_id, code(error)]).catch(() => {});
      this.emit({ event: "QUEUE_ITEM_FAILED", requestId: item.request_id, code: code(error) });
    }
  }
  async tick(signal: AbortSignal) {
    if (this.busy) throw Error("QUEUE.OVERLAPPING_TICK");
    this.busy = true;
    try {
      // Fixed, bounded sweep. A poison request cannot starve the other rows.
      const rows = (await this.queue.pool.query(`SELECT * FROM amazon_queue_item WHERE state='running' AND next_check_at<=clock_timestamp()
        ORDER BY next_check_at,item_id LIMIT 1000`)).rows as QueueItem[];
      for (const row of rows) {
        if (signal.aborted) return;
        await this.queue.locked(async db => {
          const current = (await db.query("SELECT * FROM amazon_queue_item WHERE item_id=$1 AND state='running' AND next_check_at<=clock_timestamp()", [row.item_id])).rows[0];
          if (current) await this.visit(db, current, true);
        }, false);
      }
      // At most 20 new Starts per tick. Pause can interleave between every request.
      for (let n = 0; n < 20 && !signal.aborted; n++) {
        if(this.ports.canStart && !await this.ports.canStart())break;
        const started = await this.queue.locked(async db => {
          await this.queue.fill(db);
          const item = await this.queue.claim(db);
          if (!item) return false;
          await this.visit(db, item, true); return true;
        }, false);
        if (!started) break;
      }
      await this.queue.locked(async db => {
        await this.queue.fill(db);
        await db.query(`UPDATE amazon_queue_control SET mode='paused',force_after=NULL,updated_at=clock_timestamp()
          WHERE singleton AND mode IN ('draining','stopping') AND NOT EXISTS(SELECT 1 FROM amazon_queue_item WHERE state='running')`);
      }, false);
    } finally { this.busy = false; }
  }
  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      try { await this.tick(signal); } catch (e) { this.emit({ event: "QUEUE_TICK_FAILED", code: code(e) }); }
      try { await delay(1000, undefined, { signal }); } catch { if (!signal.aborted) throw Error("QUEUE.WAIT_FAILED"); }
    }
  }
}
