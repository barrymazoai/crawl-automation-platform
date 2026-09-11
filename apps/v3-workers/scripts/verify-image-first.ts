/** Mini-only retained-evidence regression. READ-ONLY database/R2; assembly/collection use memory stores. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { ArtifactResolver, FileCopies, createR2Objects, verifyBytes, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { FileCompletionJournal, PostgresResultRegistry, OcrResultHandoff } from "@crawl-automation/v3-results";
import { RegisteredOcrEvidence, VisionHandoff, PostgresVisionRegistry, LocalVisionEvidenceStore } from "@crawl-automation/v3-vision";
import { TextEvidence, TextHandoff, PostgresTextRegistry } from "@crawl-automation/v3-text";
import { LabelProductJoinSchema, TextOutputSchema, TextCandidateV3Schema, type LabelCollectedProduct, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { PackagingEvidence, LabelProductAssembly, CollectLabelProduct } from "@crawl-automation/v3-product";
import { mergeLabelProduct, type VerifiedLabelSource } from "../../../packages/v3-product/src/label-merge.js";
import { readGncPrivateJson } from "../src/gnc-config.js";

class Memory implements ObjectStore {
  data = new Map<string, Uint8Array>();
  async read(key: string) { return this.data.get(key) ?? null; }
  async create(key: string, bytes: Uint8Array) { if (this.data.has(key)) return "exists" as const; this.data.set(key, bytes); return "created" as const; }
}
const root = process.argv[2]!, outDir = process.argv[3]!;
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.match(root, /^\/Users\/barry\/apps\/crawlv3-batch-a\.[A-Za-z0-9]+$/);
assert.match(outDir, /^\/Users\/barry\/apps\/crawlv3-image-first\.[A-Za-z0-9]+$/);
const deployment = await readGncPrivateJson(join(root, "live/deployment.json")) as any;
const config = await readGncPrivateJson(deployment.jobs.find((j: any) => j.id === "product-core-collect").env.V3_PRODUCT_CONFIG) as any;
const db = new pg.Pool({ connectionString: config.resultDatabase.connectionString, ssl: config.resultDatabase.tls ? { rejectUnauthorized: true } : false,
  connectionTimeoutMillis: 5000, statement_timeout: 10000, options: "-c default_transaction_read_only=on" });
const r2 = createR2Objects(config.r2, config.r2Credentials);
const counts = async () => (await db.query("SELECT (SELECT count(*)::int FROM processing_result) processing, (SELECT count(*)::int FROM collected_product) collected, (SELECT count(*)::int FROM review_record) reviews")).rows[0];
try {
  const before = await counts();
  const key = "v3/label-products/label-cd095e7cdb997ed34232262802a9e38d655fabf39732d0a7634b365d5eba8e33/assembly.json";
  const bytes = await r2.store.read(key, 8388608, AbortSignal.timeout(20000)); assert.ok(bytes);
  const old = JSON.parse(Buffer.from(bytes).toString()), original = LabelProductJoinSchema.parse(old.input);
  const copies = await FileCopies.open(config.cacheRoot), journal = await FileCompletionJournal.open(config.ocrJournalRoot);
  const local = await LocalVisionEvidenceStore.open(config.productLocalRoot), registry = new PostgresResultRegistry(db);
  const results = new OcrResultHandoff(config.storageId, copies, r2.store, journal, registry);
  const resolver = new ArtifactResolver(copies, r2.store), ocr = new RegisteredOcrEvidence(resolver, results, registry);
  const vision = new VisionHandoff(local, r2.store, new PostgresVisionRegistry(db), config.storageId,
    async (task, signal) => { await ocr.verifiedText(task.input.selection, signal); });
  const evidence = new TextEvidence(resolver, results), text = new TextHandoff(local, r2.store, new PostgresTextRegistry(db), evidence, config.storageId);
  const entries: VerifiedLabelSource[] = [];
  for (const source of original.manifest.sources) {
    const signal = AbortSignal.timeout(60000);
    if (source.kind === "image") entries.push({ id: source.id, kind: "image", ...await vision.readLabelCandidate(source.task, signal) });
    else {
      const facts = await text.inspect(source.task, signal);
      assert.ok(facts.artifactDurable && facts.resultRegistered && facts.record);
      const data = await r2.store.read(facts.record.result.objectKey, 524288, signal); assert.ok(data); verifyBytes(facts.record.result, data, 524288);
      const output = TextOutputSchema.parse(JSON.parse(Buffer.from(data).toString()));
      entries.push({ id: source.id, kind: "text", record: facts.record, candidate: TextCandidateV3Schema.parse(output.candidate), fullText: (await evidence.resolve(source.task, signal)).text });
    }
  }
  const packaging = await new PackagingEvidence(resolver).inspect(original.manifest.observation, original.manifest.admission!.documents, AbortSignal.timeout(60000));
  const legacy = mergeLabelProduct(original.manifest, entries, [], packaging);
  assert.deepEqual(legacy, old.result); assert.equal(legacy.status, "review");
  const next = structuredClone(original); next.manifest.operationId = "image-first-retained-evidence-validation"; next.manifest.evidencePolicy = "label-image-first/1";
  const memory = new Memory(), reviews = new Map<string, ReviewRecord>(); let record: LabelCollectedProduct | null = null;
  const deps = { local: memory, remote: memory,
    reviews: { read: async (id: string) => reviews.get(id) ?? null, append: async (r: ReviewRecord) => { reviews.set(r.reviewId, r); } },
    readPackaging: async () => packaging, readSource: async (s: typeof next.manifest.sources[number]) => structuredClone(entries.find(e => e.id === s.id)!) };
  const assembly = new LabelProductAssembly(deps), collector = new CollectLabelProduct({ ...deps, assembly,
    registry: { read: async () => record, append: async (r: LabelCollectedProduct) => { record = r; } } });
  const ready = await assembly.run(next, AbortSignal.timeout(10000)); assert.equal(ready.status, "ready");
  const result = await collector.run({ join: next, evidenceKey: ready.evidenceKey }, AbortSignal.timeout(10000)); assert.equal(result.status, "collected");
  const saved = record as LabelCollectedProduct | null; assert.ok(saved);
  const b12 = saved.formula.columns[0]!.rows.find(r => /Vitamin B12/i.test(r.name.text)); assert.ok(b12);
  assert.equal(b12.kind, "blend_component"); assert.equal(b12.parentRowIndex, 13); assert.equal(b12.name.citation.kind, "image");
  assert.deepEqual(await counts(), before);
  const proof = { at: new Date().toISOString(), mode: "retained-evidence-memory-collection", evidencePolicy: next.manifest.evidencePolicy,
    originalReviewPreserved: true, databaseWrites: 0, r2Writes: 0, modelCalls: 0, browserCalls: 0,
    original: { status: legacy.status, codes: legacy.codes }, updated: { status: result.status, persistedTo: "memory-only",
      formulaRows: saved.formula.columns.reduce((n, c) => n + c.rows.length, 0), ingredients: saved.ingredients.length,
      b12: { kind: b12.kind, parentRowIndex: b12.parentRowIndex, amount: b12.amount?.text, source: b12.name.citation.kind }, warnings: saved.warnings }, unchangedDatabaseCounts: before };
  await writeFile(join(outDir, "real-evidence-proof.json"), JSON.stringify(proof, null, 2), { mode: 0o600 });
  await writeFile(join(outDir, "real-evidence-memory-record.json"), JSON.stringify(saved, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(proof));
} finally { r2.close(); await db.end(); }
