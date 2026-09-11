/** Explicit operational tool: default audit, exact permit apply, no automatic sweeper or business retries. */
import assert from "node:assert/strict";
import { readFile, readdir, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import pg from "pg";
import { Client, Connection } from "@temporalio/client";
import { artifactBuildId } from "@crawl-automation/v3-worker-runtime";
import { createR2Objects, sha256 } from "@crawl-automation/v3-artifacts";
import { ExecutionIdSchema, ResourceRequestSchema } from "@crawl-automation/v3-contracts";
import { PostgresResourceAdmission } from "../../../packages/v3-product/src/resource-admission.js";
import { ResourceRecovery, restoreComputedHandoff } from "../../../packages/v3-product/src/resource-recovery.js";
import { TemporalResourceEvidence, verifySuccessfulEffect } from "../src/temporal-resource-evidence.js";
import { openRecoveryHandoff, verifyComputedEffect } from "../src/recovery-handoff.js";
import { readGncPrivateJson } from "../src/gnc-config.js";

async function main() {
  const [root, mode = "--audit", permitId, operationId] = process.argv.slice(2);
  assert.match(root!, /^\/Users\/barry\/apps\/crawlv3-batch-a\.[A-Za-z0-9]+$/);
  assert.ok(["--audit", "--release", "--prove", "--inspect-handoff", "--restore-handoff"].includes(mode));
  if (mode !== "--audit") ExecutionIdSchema.parse(permitId);
  if (mode.endsWith("handoff")) ExecutionIdSchema.parse(operationId);
  const m = await readGncPrivateJson(join(root!, "live/deployment.json")) as any;
  assert.equal(m.host, hostname()); assert.equal(m.root, root);
  const workflowJob = m.jobs.find((j: any) => j.id === "gnc-core-stream-workflow"), runtime = await readGncPrivateJson(workflowJob.env.V3_WORKER_CONFIG) as any;
  const release = dirname(workflowJob.entry), bundlePath = join(release, "product-workflows.cjs");
  const files = (await readdir(release)).filter(f => f.endsWith(".js")).map(f => join(release, f));
  assert.equal(await artifactBuildId([...files, bundlePath].sort()), runtime.expectedBuildId, "Pinned deployed Workflow build mismatch");
  const config = await readGncPrivateJson(m.jobs.find((j: any) => j.id === "product-core-collect").env.V3_PRODUCT_CONFIG) as any;
  assert.deepEqual(config.collectionDatabase, m.database);
  const configPaths: Record<string, string> = {};
  for (const [type, role, key] of [["ocrFile", "ocr-file", "V3_OCR_CONFIG"], ["interpretText", "codex-text", "V3_TEXT_CONFIG"], ["interpretImage", "codex-vision", "V3_VISION_CONFIG"]]) {
    const path = m.jobs.find((j: any) => j.id === role).env[key!]; const c = await readGncPrivateJson(path) as any;
    assert.deepEqual(c.resultDatabase, m.database); assert.deepEqual(c.reviewDatabase, m.database); assert.deepEqual(c.r2, config.r2);
    configPaths[type!] = path;
  }
  if (mode === "--restore-handoff") {
    // Prevent a stopped-run late worker from racing a Review write. Never kills a process to satisfy this condition.
    await assert.rejects(lstat(join(root!, "supervisor.lock")), { code: "ENOENT" });
    for (const j of m.jobs) { const h = JSON.parse(await readFile(join(root!, `${j.id}.health.json`), "utf8")); assert.throws(() => process.kill(h.pid, 0), { code: "ESRCH" }); }
  }
  const apply = mode === "--release" || mode === "--restore-handoff";
  const db = new pg.Pool({ connectionString: m.database.connectionString, ssl: m.database.tls ? { rejectUnauthorized: true } : false,
    max: 2, statement_timeout: 5000, connectionTimeoutMillis: 5000, ...(!apply ? { options: "-c default_transaction_read_only=on" } : {}) });
  const r2 = createR2Objects(config.r2, config.r2Credentials), t = runtime.transport;
  const connection = await Connection.connect({ address: runtime.address, tls: { serverNameOverride: t.serverName,
    serverRootCACertificate: await readFile(t.caFile), clientCertPair: { crt: await readFile(t.certFile), key: await readFile(t.keyFile) } } });
  try {
    const client = new Client({ connection, namespace: runtime.namespace }), ledger = new PostgresResourceAdmission(db);
    const inspector = new TemporalResourceEvidence({ client, namespace: runtime.namespace, bundlePath, bundleSha256: sha256(await readFile(bundlePath)), store: r2.store,
      verifyEffect: async (e, signal) => configPaths[e.activityType] ? verifyComputedEffect(configPaths[e.activityType]!, e) : verifySuccessfulEffect(e, r2.store, signal) });
    if (mode.endsWith("handoff")) {
      const permit = await ledger.read(permitId!); assert.ok(permit);
      const handle = client.workflow.getHandle(permit.request.workflowId, permit.request.runId), d = await handle.describe();
      assert.equal(d.runId, permit.request.runId); assert.ok(["COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"].includes(d.status.name), "Owner still running or unconfirmed");
      const history = await handle.fetchHistory(), matches: { type: string; input: any }[] = [];
      for (const e of history.events ?? []) {
        const a = e.activityTaskScheduledEventAttributes;
        if (!a?.activityType?.name || !configPaths[a.activityType.name] || a.input?.payloads?.length !== 1) continue;
        const payload = a.input.payloads[0]!;
        if (Buffer.from(payload.metadata?.encoding ?? []).toString() !== "json/plain") continue;
        const input = JSON.parse(Buffer.from(payload.data ?? []).toString());
        if ((input.operationId ?? input.input?.operationId) === operationId) matches.push({ type: a.activityType.name, input });
      }
      assert.equal(matches.length, 1, "Exact single original activity required");
      const match = matches[0]!, port = await openRecoveryHandoff(configPaths[match.type]!, match.type, match.input, !apply);
      try { console.log(JSON.stringify({ mode, permitId, operationId, ...(await restoreComputedHandoff(port, apply)), permitReleased: false, workflowResumed: false })); }
      finally { await port.dispose(); } return;
    }
    if (mode === "--prove") {
      const p = await ledger.read(permitId!); assert.ok(p); const e = await inspector.inspect(p.request);
      console.log(JSON.stringify(e.status === "verified" ? { mode, status: e.status, proof: e.proof, databaseWrites: 0 } : { mode, ...e })); return;
    }
    const recovery = new ResourceRecovery(ledger, r => inspector.inspect(r), r2.store);
    const ids = permitId ? [permitId] : (await db.query("SELECT permit_id FROM resource_permit WHERE released_at IS NULL ORDER BY granted_at LIMIT 101")).rows.map(r => r.permit_id);
    assert.ok(ids.length <= 100, "Audit capped at 100; inspect exact permits separately");
    const results = [];
    for (const id of ids) { ResourceRequestSchema.parse((await ledger.read(id))!.request); results.push(await recovery.run(id, apply, AbortSignal.timeout(180000))); }
    console.log(JSON.stringify({ mode, namespace: runtime.namespace, inspected: ids.length, results, businessExecutions: 0, oldReviewsModified: 0 }));
  } finally { await connection.close(); r2.close(); await db.end(); }
}
main().catch(() => { console.error(JSON.stringify({ event: "RESOURCE_RECOVERY_REJECTED", message: "Check exact scope, owner state, maintenance conditions and evidence; no force release" })); process.exitCode = 1; });
