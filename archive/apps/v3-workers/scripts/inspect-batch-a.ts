/** Read-only acceptance audit. Only writes its own report/history files. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { Connection, Client } from "@temporalio/client";
import { createR2Objects, verifyBytes } from "@crawl-automation/v3-artifacts";
import { ArtifactRefSchema, LabelCollectedProductSchema } from "@crawl-automation/v3-contracts";
import { readGncPrivateJson } from "../src/gnc-config.js";

const root = process.argv[2]!;
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.match(root, /^\/Users\/barry\/apps\/crawlv3-batch-a\.[A-Za-z0-9]+$/);
const manifest = await readGncPrivateJson(join(root, "live/deployment.json")) as any;
const config = await readGncPrivateJson(manifest.jobs.find((j: any) => j.id === "product-core-collect").env.V3_PRODUCT_CONFIG) as any;
const runtime = await readGncPrivateJson(manifest.jobs.find((j: any) => j.id === "gnc-core-stream-workflow").env.V3_WORKER_CONFIG) as any;
const t = runtime.transport;
const db = new pg.Pool({ connectionString: config.collectionDatabase.connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
const r2 = createR2Objects(config.r2, config.r2Credentials);
const connection = await Connection.connect({ address: runtime.address, tls: { serverNameOverride: t.serverName,
  serverRootCACertificate: await readFile(t.caFile), clientCertPair: { crt: await readFile(t.certFile), key: await readFile(t.keyFile) } } });
try {
  const products = (await db.query("SELECT record FROM collected_product ORDER BY operation_id")).rows.map(r => LabelCollectedProductSchema.parse(r.record));
  const processing = (await db.query("SELECT record FROM processing_result ORDER BY operation_id")).rows.map(r => r.record);
  const refs = new Map<string, ReturnType<typeof ArtifactRefSchema.parse>>();
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    const ref = ArtifactRefSchema.safeParse(value);
    if (ref.success) {
      const old = refs.get(ref.data.objectKey);
      if (old) assert.equal(old.sha256, ref.data.sha256);
      refs.set(ref.data.objectKey, ref.data);
    }
    for (const child of Object.values(value)) visit(child);
  }
  products.forEach(visit); processing.forEach(visit);
  for (const ref of refs.values()) {
    const bytes = await r2.store.read(ref.objectKey, Math.max(ref.byteSize, 1), AbortSignal.timeout(15000));
    assert.ok(bytes, `Missing retained artifact ${ref.artifactId}`);
    verifyBytes(ref, bytes, ref.byteSize);
  }
  const client = new Client({ connection, namespace: runtime.namespace }), workflows = [];
  for await (const item of client.workflow.list()) {
    const handle = client.workflow.getHandle(item.workflowId, item.runId), history = await handle.fetchHistory();
    await writeFile(join(root, "live", `history-${item.runId}.json`), JSON.stringify(history), { mode: 0o600 });
    workflows.push({ workflowId: item.workflowId, runId: item.runId, type: item.type, status: item.status.name,
      result: item.type === "ScheduledCollectionIntake" && item.status.name === "COMPLETED" ? await handle.result() : undefined });
  }
  const schedules = [];
  for await (const s of client.schedule.list()) {
    const d = await client.schedule.getHandle(s.scheduleId).describe();
    schedules.push({ scheduleId: s.scheduleId, paused: d.state.paused, actions: d.info.numActionsTaken });
  }
  const report = { at: new Date().toISOString(), namespace: runtime.namespace,
    counts: { submissions: (await db.query("SELECT count(*)::int n FROM collection_submission")).rows[0].n,
      processing: processing.length, collected: products.length, reviews: (await db.query("SELECT count(*)::int n FROM review_record")).rows[0].n,
      heldResources: (await db.query("SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL")).rows[0].n },
    retainedArtifactsVerified: refs.size, products: products.map(p => ({ observationId: p.observation.observationId, listingId: p.observation.listingId,
      formulaRows: p.formula.columns.reduce((n, c) => n + c.rows.length, 0), ingredients: p.ingredients.length, warnings: p.warnings.map(w => w.code) })), workflows, schedules };
  await writeFile(join(root, "live/acceptance-audit.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally { r2.close(); await db.end(); await connection.close(); }
