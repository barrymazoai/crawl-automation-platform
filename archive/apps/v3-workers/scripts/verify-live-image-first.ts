/** Read-only audit of one new web-submitted, image-first GNC request. No replay or provider calls. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { Client, Connection } from "@temporalio/client";
import { createR2Objects, verifyBytes, sha256 } from "@crawl-automation/v3-artifacts";
import { ArtifactRefSchema, CatalogProductBindingSchema, LabelCollectedProductSchema, labelTypographyStructure } from "@crawl-automation/v3-contracts";
import { PostgresLabelCollectedProducts } from "@crawl-automation/v3-product";
import { fixture, compareGncSample } from "./quality/gnc-sample.js";
import { readGncPrivateJson } from "../src/gnc-config.js";

const [root, outDir, requestId] = process.argv.slice(2);
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.match(root!, /^\/Users\/barry\/apps\/crawlv3-batch-a\.[A-Za-z0-9]+$/);
assert.match(outDir!, /^\/Users\/barry\/apps\/crawlv3-live-image-first\.[A-Za-z0-9]+$/);
assert.match(requestId!, /^[a-f0-9-]{36}$/);
const deployment = await readGncPrivateJson(join(root!, "live/deployment.json")) as any;
const config = await readGncPrivateJson(deployment.jobs.find((j: any) => j.id === "product-core-collect").env.V3_PRODUCT_CONFIG) as any;
const runtime = await readGncPrivateJson(deployment.jobs.find((j: any) => j.id === "gnc-core-stream-workflow").env.V3_WORKER_CONFIG) as any;
const db = new pg.Pool({ connectionString: config.collectionDatabase.connectionString, connectionTimeoutMillis: 5000, statement_timeout: 10000,
  options: "-c default_transaction_read_only=on" });
const r2 = createR2Objects(config.r2, config.r2Credentials), t = runtime.transport;
const connection = await Connection.connect({ address: runtime.address, tls: { serverNameOverride: t.serverName,
  serverRootCACertificate: await readFile(t.caFile), clientCertPair: { crt: await readFile(t.certFile), key: await readFile(t.keyFile) } } });
try {
  const client = new Client({ connection, namespace: runtime.namespace });
  const rows = (await db.query("SELECT b.record,d.record AS discovery FROM catalog_product_input b JOIN catalog_discovery d USING(discovery_id) WHERE d.catalog_id=$1", [requestId])).rows;
  assert.equal(rows.length, 1, "This fixture only validates the bounded one-SKU Brand");
  const binding = CatalogProductBindingSchema.parse(rows[0].record), input = binding.input.input, owner = input.sourcePlan.task.owner;
  assert.equal(input.evidencePolicy, "label-image-first/1"); assert.equal(owner.listingId, fixture.source.listingId);
  const product = await new PostgresLabelCollectedProducts(db).read(input.operationId); assert.ok(product, "New product not collected yet");
  assert.equal(product.evidencePolicy, "label-image-first/1"); assert.deepEqual(product.observation, owner);
  const workflows = [];
  for (const workflowId of [`v3-collection-${requestId}`, `v3-collection-${requestId}-catalog`, rows[0].discovery.workflowId, `${rows[0].discovery.workflowId}-gnc`]) {
    const handle = client.workflow.getHandle(workflowId), d = await handle.describe(); assert.equal(d.status.name, "COMPLETED");
    workflows.push({ workflowId, runId: d.runId, status: d.status.name, result: await handle.result() });
    await writeFile(join(outDir!, `history-${d.runId}.json`), JSON.stringify(await handle.fetchHistory()), { mode: 0o600, flag: "wx" });
  }
  const processing = (await db.query("SELECT record FROM processing_result")).rows.map(r => r.record)
    .filter(r => (r.input?.observationId ?? r.input?.selection?.observation?.observationId) === owner.observationId);
  const reviews = (await db.query("SELECT record FROM review_record")).rows.map(r => r.record);
  assert.equal(reviews.filter(r => r.observation.observationId === owner.observationId || r.observation.requestId === requestId).length, 0);
  const pages = (await db.query("SELECT record FROM catalog_page WHERE catalog_id=$1 ORDER BY page_index", [requestId])).rows.map(r => r.record);
  const closure = (await db.query("SELECT status FROM catalog_closure WHERE catalog_id=$1", [requestId])).rows[0]; assert.equal(closure?.status, "complete");
  const refs = new Map<string, ReturnType<typeof ArtifactRefSchema.parse>>();
  function visit(v: unknown) {
    if (!v || typeof v !== "object") return;
    const r = ArtifactRefSchema.safeParse(v); if (r.success) refs.set(r.data.objectKey, r.data);
    Object.values(v).forEach(visit);
  }
  visit(product); processing.forEach(visit); pages.forEach(visit);
  for (const ref of refs.values()) {
    const bytes = await r2.store.read(ref.objectKey, ref.byteSize, AbortSignal.timeout(20000)); assert.ok(bytes); verifyBytes(ref, bytes, ref.byteSize);
  }
  const assembly = await r2.store.read(product.assembly.objectKey, product.assembly.byteSize, AbortSignal.timeout(20000)); assert.ok(assembly);
  assert.equal(assembly.length, product.assembly.byteSize); assert.equal(sha256(assembly), product.assembly.sha256);
  const output = JSON.parse(Buffer.from(assembly).toString()); assert.equal(output.result.status, "ready");
  assert.equal(output.input.manifest.evidencePolicy, product.evidencePolicy);
  const images = product.provenance.filter(p => p.kind === "image"); assert.equal(images.length, 1);
  assert.equal(images[0]!.record.input.selection.image.sha256, fixture.evidence.images[fixture.evidence.transcribedImageIndex]!.sha256);
  const candidates = product.provenance.map(p => ({ id: p.id, kind: p.kind, ...compareGncSample(p.candidate) }));
  // Quality comparison is reporting only, never changes admission or the stored product.
  const collectedCandidate = { ...images[0]!.candidate, formula: product.formula, otherIngredients: product.otherIngredients };
  const comparison = compareGncSample(collectedCandidate as any), shape = labelTypographyStructure(collectedCandidate as any, "label-typography/2")!;
  const withoutHeadings = (f: any) => ({ servingSize: f.servingSize, columns: f.columns.map((c: any) => ({ rows: c.rows })) });
  assert.deepEqual(withoutHeadings(shape), withoutHeadings(fixture.expected.formula));
  assert.ok(comparison.differences.every(p => /^formula\.columns\.\d+\.heading$/.test(p)), "Non-heading content differs from independent label baseline");
  const health = JSON.parse(await readFile(join(root!, "status.json"), "utf8")); assert.ok(Date.now() - Date.parse(health.at) < 15000); assert.ok(health.jobs.every((j: any) => j.ready));
  const counts = (await db.query("SELECT (SELECT count(*)::int FROM collection_submission) submissions,(SELECT count(*)::int FROM processing_result) processing,(SELECT count(*)::int FROM collected_product) collected,(SELECT count(*)::int FROM review_record) reviews,(SELECT count(*)::int FROM source_submission_guard) guards,(SELECT count(*)::int FROM resource_permit WHERE released_at IS NULL) held")).rows[0];
  assert.equal(counts.guards, 0); assert.equal(counts.held, 0);
  const proof = { at: new Date().toISOString(), requestId, operationId: product.operationId, observationId: owner.observationId,
    evidencePolicy: product.evidencePolicy, mode: "new-web-request-real-database-collection", namespace: runtime.namespace,
    catalog: { pages: pages.length, discoveries: rows.length, closure: closure.status }, workflows,
    newProcessing: processing.map(r => ({ operationId: r.input.operationId, module: r.input.module ?? "codex.vision" })),
    retainedArtifactsVerified: refs.size, assemblyVerified: true, candidates, collectedComparison: comparison,
    coreRowsAndIngredientsMatch: true, formulaRows: shape.columns.reduce((n, c) => n + c.rows.length, 0), ingredients: product.ingredients.length,
    otherIngredients: product.otherIngredients?.items.length, warnings: product.warnings, newReviews: 0, cumulativeCounts: counts,
    readyWorkers: health.jobs.length, auditWritesToDatabase: 0, auditProviderCalls: 0, legacyDatabaseRead: false, userReviewed: false };
  await writeFile(join(outDir!, "live-proof.json"), JSON.stringify(proof, null, 2), { mode: 0o600, flag: "wx" });
  await writeFile(join(outDir!, "collected-record.json"), JSON.stringify(LabelCollectedProductSchema.parse(product), null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(proof));
} finally { r2.close(); await db.end(); await connection.close(); }
