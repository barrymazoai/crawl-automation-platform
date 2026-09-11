// Mini-only readback. Does not submit, cancel, retry, or change business records.
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const [dir, requestId, mode] = process.argv.slice(2);
const root = "/Users/barry/apps/crawlv3-batch-a.UiA4dx";
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.ok(dir?.startsWith(root + "/live/channel-resident-20260910"));
assert.match(requestId, /^[a-f0-9-]{36}$/);
assert.ok(!mode || mode === "--verify-final");
const require = createRequire(root + "/package.json"), pg = require("pg");
const { Client, Connection } = require("@temporalio/client");
let c = JSON.parse(await fs.readFile(dir + "/swanson.private.json", "utf8"));
const runtime = JSON.parse(await fs.readFile(dir + "/swanson-brand-workflow.runtime.json", "utf8"));
const t = runtime.transport;
const db = new pg.Pool({ connectionString: c.database.connectionString, options: "-c default_transaction_read_only=on", max: 2 });
const connection = await Connection.connect({ address: runtime.address, tls: { serverNameOverride: t.serverName, serverRootCACertificate: await fs.readFile(t.caFile), clientCertPair: { crt: await fs.readFile(t.certFile), key: await fs.readFile(t.keyFile) } } });
try {
  const client = new Client({ connection, namespace: runtime.namespace });
  const submission = (await db.query("SELECT snapshot FROM collection_submission WHERE request_id=$1", [requestId])).rows[0];
  const gnc = JSON.stringify(submission?.snapshot).includes('"gnc"');
  if (gnc) {
    const manifest = JSON.parse(await fs.readFile(root + "/live/deployment.json", "utf8"));
    c = JSON.parse(await fs.readFile(manifest.jobs.find(j => j.id === "product-core-collect").env.V3_PRODUCT_CONFIG, "utf8"));
  }
  const out = dir + "/evidence/request-" + requestId;
  await fs.mkdir(out, {recursive:true,mode:0o700});
  const discoveries = (await db.query("SELECT record FROM catalog_discovery WHERE catalog_id=$1 ORDER BY discovery_id", [requestId])).rows.map(r => r.record);
  const bindings = (await db.query("SELECT record FROM catalog_product_input WHERE discovery_id=ANY($1::text[])", [discoveries.map(d=>d.discoveryId)])).rows.map(r=>r.record);
  const businessRequests = [requestId, ...bindings.map(b=>b.input.input.sourcePlan.task.owner.requestId)];
  const workflowIds = [`v3-collection-${requestId}`, `v3-collection-${requestId}-catalog`, ...discoveries.flatMap(d => [d.workflowId, d.workflowId + (gnc ? "-gnc" : "-label")])];
  const evidence = [...bindings];
  for (const table of ["catalog_page", "catalog_closure", "catalog_dispatch", "catalog_product_input"])
    evidence.push(...(await db.query(`SELECT row_to_json(t) AS value FROM ${table} t`)).rows.map(r => r.value).filter(r => JSON.stringify(r).includes(requestId)));
  const rows = {};
  for (const table of ["collected_product", "review_record", "processing_result"])
    rows[table] = (await db.query(`SELECT record_hash, record FROM ${table} WHERE record::text LIKE ANY($1::text[])`, [businessRequests.map(id=>"%"+id+"%")])).rows;
  const workflows = [];
  await fs.mkdir(dir + "/evidence", { recursive: true, mode: 0o700 });
  for (const id of workflowIds) {
    const handle = client.workflow.getHandle(id);
    let d;
    try { d = await handle.describe(); } catch (e) { if (e.name === "WorkflowNotFoundError") { workflows.push({ workflowId: id, status: "NOT_STARTED" }); continue; } throw e; }
    const item = { workflowId: id, runId: d.runId, type: d.type, status: d.status.name,
      pending: d.raw.pendingActivities?.map(a => ({ type: a.activityType?.name, state: a.state, attempt: a.attempt, lastFailure: a.lastFailure?.message })) ?? [] };
    if (d.status.name === "COMPLETED") item.result = await handle.result();
    if (mode) {
      const history = await handle.fetchHistory();
      await fs.writeFile(out + `/history-${d.runId}.json`, JSON.stringify(history), { mode: 0o600 });
      item.events = history.events?.length;
      if (d.status.name === "FAILED") item.failure = history.events?.at(-1)?.workflowExecutionFailedEventAttributes?.failure;
    }
    workflows.push(item);
  }
  const permits = (await db.query("SELECT permit_id,request,released_at FROM resource_permit WHERE request->>'workflowId'=ANY($1::text[])", [workflowIds])).rows;
  const report = { requestId, at: new Date().toISOString(), workflows, discoveries: discoveries.map(d => ({ id: d.discoveryId, entry: d.entry })),
    delivery: (await db.query("SELECT request_id,target,run_id,observed_status,last_issue,closed_at FROM workflow_delivery WHERE request_id=$1", [requestId])).rows,
    counts: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])),
    reviews: rows.review_record.map(r => ({ id: r.record.reviewId, listingId: r.record.observation.listingId, failure: r.record.failure })),
    products: rows.collected_product.map(r => ({ observation: r.record.observation, formula: r.record.formula, ingredients: r.record.ingredients, warnings: r.record.warnings })),
    permits, held: permits.filter(p => !p.released_at).length };
  if (mode) {
    const refs = new Map();
    function visit(v) { if (!v || typeof v !== "object") return; if (typeof v.objectKey === "string" && typeof v.sha256 === "string" && typeof v.byteSize === "number") { const old = refs.get(v.objectKey); if (old) assert.equal(old.sha256, v.sha256); refs.set(v.objectKey, v); } Object.values(v).forEach(visit); }
    visit(discoveries); visit(evidence); visit(rows); visit(workflows);
    const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
    const s3 = new S3Client({ endpoint: c.r2.endpoint, region: "auto", credentials: c.r2Credentials, maxAttempts: 1, forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
    report.artifacts = [];
    try {
      for (const ref of refs.values()) {
        const response = await s3.send(new GetObjectCommand({ Bucket: c.r2.bucket, Key: c.r2.prefix + "/" + ref.objectKey }), { abortSignal: AbortSignal.timeout(20000) });
        assert.equal(response.ContentLength, ref.byteSize);
        const bytes = Buffer.from(await response.Body.transformToByteArray());
        assert.equal(bytes.length, ref.byteSize); assert.equal(createHash("sha256").update(bytes).digest("hex"), ref.sha256);
        report.artifacts.push({ key: ref.objectKey, sha256: ref.sha256, byteSize: bytes.length, verified: true });
        if (ref.kind === "source-image") {
          const extension = ref.mediaType === "image/png" ? "png" : ref.mediaType === "image/jpeg" ? "jpg" : null;
          if (extension) await fs.writeFile(out + `/source-${ref.sha256}.${extension}`, bytes, { mode: 0o600 });
        }
      }
      report.modelStopProofs = [];
      for (const row of gnc ? [] : rows.review_record) {
        const review = row.record;
        if (!/^(TEXT|VISION)\.LABEL_/.test(review.failure.code)) continue;
        const workflow = workflows.find(w => ["ChannelSavedLabelWorkflow","ChannelStreamingLabelWorkflow"].includes(w.type) && w.result?.observationId === review.observation.observationId);
        assert.ok(workflow);
        const activityName = review.failure.stage === "codex.vision" ? "interpretImage" : "interpretText";
        const key = "v3/model-returns/" + createHash("sha256").update(JSON.stringify([workflow.workflowId, workflow.runId, activityName, review.failure.operationId])).digest("hex") + ".json";
        const read = async key => {
          const response = await s3.send(new GetObjectCommand({ Bucket: c.r2.bucket, Key: c.r2.prefix + "/" + key }), { abortSignal: AbortSignal.timeout(20000) });
          assert.ok(response.ContentLength < 65536); return JSON.parse(Buffer.from(await response.Body.transformToByteArray()).toString());
        };
        const returned = await read(key);
        assert.equal(returned.codec, "model-return-attestation/1"); assert.equal(returned.reviewId, review.reviewId);
        assert.equal(returned.invocation.inputFingerprint, review.failure.inputFingerprint);
        assert.equal(returned.invocation.workflowId, workflow.workflowId); assert.equal(returned.invocation.runId, workflow.runId);
        assert.deepEqual(returned.invocation.owner, review.observation);
        let found = false;
        for (const permit of permits.filter(p => p.request.workflowId === workflow.workflowId && p.request.needs.some(n => n.resourceId === "mini-model-account"))) {
          const stopKey = `v3/resource-stop/${permit.permit_id}.json`;
          let stopped;
          try { stopped = await read(stopKey); } catch (e) { if (e.name === "NoSuchKey") continue; throw e; }
          if (stopped.reviewId !== review.reviewId) continue;
          assert.equal(stopped.codec, "owned-model-review-stop/1"); assert.deepEqual(stopped.request, permit.request);
          assert.deepEqual(stopped.invocation, returned.invocation); assert.ok(permit.released_at);
          report.modelStopProofs.push({ reviewId: review.reviewId, returnKey: key, stopKey, permitId: permit.permit_id, releasedAt: permit.released_at, verified: true }); found = true;
        }
        assert.ok(found, "Quality Review requires a matching durable stop proof");
      }
    } finally { s3.destroy(); }
    const before = JSON.parse(await fs.readFile(dir + "/baseline.json", "utf8"));
    for (const [table, hashes] of Object.entries(before.hashes)) {
      const now = new Set((await db.query(`SELECT record_hash FROM ${table}`)).rows.map(r => r.record_hash));
      for (const hash of hashes) assert.ok(now.has(hash));
    }
    report.oldRecordsPreserved = true;
    await fs.writeFile(out + "/records.json", JSON.stringify({ discoveries, evidence, rows }), { mode: 0o600 });
  }
  await fs.writeFile(out + "/report.json", JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, permits: { total: permits.length, held: report.held }, products: report.products.map(p => ({ observation: p.observation, formulaRows: p.formula?.columns?.reduce((n, col) => n + col.rows.length, 0), ingredients: p.ingredients?.length })), artifacts: report.artifacts?.length }));
} finally { await db.end(); await connection.close(); }
