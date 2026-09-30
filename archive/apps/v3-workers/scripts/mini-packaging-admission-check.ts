// Real saved R2/registry evidence + isolated PostgreSQL. No browser, OCR, model or old-record writes.
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { readFile, writeFile, mkdtemp, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { parseEnv, promisify } from "node:util";
import { join } from "node:path";
import pg from "pg";
import { LabelProductJoinSchema, LabelCollectedProductSchema, VisionRecordSchema, ReviewRecordSchema, TextDocumentSchema } from "@crawl-automation/v3-contracts";
import { createR2Objects, FileCopies, ArtifactResolver, sha256, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { OcrResultHandoff, PostgresResultRegistry, FileCompletionJournal, validateRecord } from "@crawl-automation/v3-results";
import { LocalVisionEvidenceStore, VisionHandoff, PostgresVisionRegistry, RegisteredOcrEvidence } from "@crawl-automation/v3-vision";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { PackagingEvidence, LabelProductAssembly, CollectLabelProduct, PostgresLabelCollectedProducts, labelCollectedHash } from "@crawl-automation/v3-product";

assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.equal(process.argv[2], "--saved-negative-and-synthetic-db");
const syntheticPath = process.argv[3]!;
assert.match(syntheticPath, /^\/Users\/barry\/apps\/crawlv3-packaging-tests\.[A-Za-z0-9]+\/synthetic-collected\.json$/);
const sample = JSON.parse(await readFile(syntheticPath, "utf8")); assert.equal(sample.synthetic, true);
const synthetic = LabelCollectedProductSchema.parse(sample.record); assert.equal(synthetic.schemaVersion, 4);
const root = await mkdtemp("/Users/barry/apps/crawlv3-packaging-admission."), container = `v3-packaging-${randomUUID().slice(0, 8)}`;
const exec = promisify(execFile), password = randomUUID();
const proof: Record<string, unknown> = { root, container, browserCalls: 0, modelCalls: 0, ocrCalls: 0, temporalCalls: 0, syntheticPositiveIsNotRealProduct: true };
let db: pg.Pool | undefined, started = false, oldStore: ReturnType<typeof createR2Objects> | undefined, outputStore: ReturnType<typeof createR2Objects> | undefined;
try {
  const envFile = join(root, "postgres.env");
  await writeFile(envFile, `POSTGRES_USER=tester\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=crawler_v3_test\n`, { mode: 0o600, flag: "wx" });
  await exec("docker", ["run", "-d", "--name", container, "--env-file", envFile, "--publish", "127.0.0.1::5432", "postgres:18"]); started = true;
  const port = Number((await exec("docker", ["port", container, "5432/tcp"])).stdout.trim().split(":").at(-1)); assert.ok(port > 0);
  db = new pg.Pool({ host: "127.0.0.1", port, user: "tester", password, database: "crawler_v3_test", connectionTimeoutMillis: 1000 });
  const deadline = Date.now() + 30000;
  while (true) { try { await db.query("SELECT 1"); break; } catch { if (Date.now() > deadline) throw Error("DATABASE_START_TIMEOUT"); await new Promise(r => setTimeout(r, 250)); } }
  for (const name of ["006_processing_results.sql", "007_review_records.sql", "008_collected_products.sql", "009_mixed_collected_products.sql", "010_label_collected_products.sql", "011_label_processing_results.sql"])
    await db.query(await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8"));
  const registry = new PostgresLabelCollectedProducts(db);
  await assert.rejects(registry.append(synthetic), { code: "23514", constraint: "collected_product_codec" });
  proof.oldSchemaRejectsV4 = true;
  await db.query(await readFile(new URL("./migrations/012_packaging_collected_products.sql", import.meta.url), "utf8"));
  await registry.append(synthetic); await registry.append(synthetic);
  assert.deepEqual(await registry.read(synthetic.operationId), synthetic);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM collected_product")).rows[0].n), 1);
  const shuffled = (x: any): any => Array.isArray(x) ? x.map(shuffled) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).reverse().map(([k, v]) => [k, shuffled(v)])) : x;
  assert.equal(labelCollectedHash(shuffled(synthetic)), labelCollectedHash(synthetic));
  proof.syntheticV4DatabaseReadback = true; proof.syntheticDuplicateInsertIdempotent = true;
  for (const mutation of [{ codec: "collected-product/5" }, { admissionPolicy: "unknown/1" }, { packaging: null }])
    await assert.rejects(db.query("INSERT INTO collected_product(operation_id,observation_id,record_hash,record) VALUES($1,$2,$3,$4::jsonb)",
      [synthetic.operationId, synthetic.observation.observationId, labelCollectedHash(synthetic), JSON.stringify({ ...synthetic, ...mutation })]), { code: "23514" });
  await assert.rejects(db.query("UPDATE collected_product SET record=record"), { code: "23514" });
  await assert.rejects(db.query("DELETE FROM collected_product"), { code: "23514" });
  proof.invalidCodecsAndMutationsRejected = true;

  const live = "/Users/barry/apps/crawlv3-gnc-saved.fhosf9/live";
  const snapshotBytes = await readFile(join(live, "database-evidence.json")), snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  const original = JSON.parse(await readFile(join(live, "workflow-input.json"), "utf8"));
  const manifest = original.manifest;
  const text = manifest.sources.find((s: any) => s.kind === "text"), image = manifest.sources.find((s: any) => s.kind === "image");
  assert.equal(manifest.observation.listingId, "613701"); assert.equal(text.task.source.kind, "prepared");
  const reviews = new PostgresReviews(db), oldReviews = snapshot.reviews.map((r: any) => ReviewRecordSchema.parse(r.record));
  for (const r of oldReviews) await reviews.append(r);
  const textReview = oldReviews.find((r: any) => r.failure.operationId === text.task.operationId)!; assert.ok(textReview);
  const ocrRecord = validateRecord(snapshot.results.find((r: any) => r.record.schemaVersion === 1).record);
  const visionRecord = VisionRecordSchema.parse(snapshot.results.find((r: any) => r.record.codec === "vision-result/2").record);
  const ocrRegistry = new PostgresResultRegistry(db), visionRegistry = new PostgresVisionRegistry(db);
  const privatePath = "/Users/barry/apps/crawlv3-gnc-live-ioVGhu/.env.r2", mode = await lstat(privatePath);
  assert.ok(mode.isFile() && !mode.isSymbolicLink() && !(mode.mode & 0o077));
  const env = parseEnv(await readFile(privatePath, "utf8")); assert.equal(env.CLOUDFLARE_R2_BUCKET, "supply-smart-test");
  const credentials = { accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID!, secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY! };
  const scope = { endpoint: env.CLOUDFLARE_R2_ENDPOINT!, bucket: env.CLOUDFLARE_R2_BUCKET!, timeoutMs: 20000 };
  oldStore = createR2Objects({ ...scope, prefix: "crawlv3-acceptance/gnc-live-19c120bf-a716-4333-b005-e015babea3c3" }, credentials);
  let sourceReads = 0, outputWrites = 0;
  const oldRemote = { read: (...args: Parameters<ObjectStore["read"]>) => { sourceReads++; return oldStore!.store.read(...args); },
    create: async (): Promise<never> => { throw Error("OLD_EVIDENCE_WRITE_DENIED"); } };
  const outputPrefix = `crawlv3-acceptance/packaging-${randomUUID()}`;
  outputStore = createR2Objects({ ...scope, prefix: outputPrefix }, credentials);
  const remote = { read: outputStore.store.read.bind(outputStore.store), create: (...args: Parameters<ObjectStore["create"]>) => { outputWrites++; return outputStore!.store.create(...args); } };
  const copies = await FileCopies.open(join(root, "cache")), artifacts = new ArtifactResolver(copies, oldRemote);
  const journal = await FileCompletionJournal.open(join(root, "ocr-journal")), local = await LocalVisionEvidenceStore.open(join(root, "local"));
  const ocrHandoff = new OcrResultHandoff("gnc-live-r2/1", copies, oldRemote, journal, ocrRegistry), signal = AbortSignal.timeout(180000);
  await journal.create(ocrRecord); assert.ok((await ocrHandoff.inspect(ocrRecord.input, signal)).artifactDurable);
  assert.ok((await ocrHandoff.register(ocrRecord.input, signal)).resultRegistered);
  const ocr = new RegisteredOcrEvidence(artifacts, ocrHandoff, ocrRegistry);
  await ocr.verifiedText(image.task.input.selection, signal);
  // Registration is an import into an isolated database, then full original result/completion verification.
  await visionRegistry.register(visionRecord);
  const vision = new VisionHandoff(local, oldRemote, visionRegistry, "gnc-live-r2/1", async (task, s) => { await ocr.verifiedText(task.input.selection, s); });
  const verified = await vision.readLabelCandidate(image.task, signal);
  const packaging = new PackagingEvidence(artifacts);
  const input = LabelProductJoinSchema.parse({ manifest: { ...manifest, operationId: `packaging-review-${randomUUID()}`,
    admission: { policy: "label-packaging/1", documents: [text.task.source.document] } },
    states: [{ id: text.id, status: "review", reviewId: textReview.reviewId }, { id: image.id, status: "registered" }] });
  const deps = { local, remote, reviews,
    readPackaging: (m: typeof input.manifest, s: AbortSignal) => packaging.inspect(m.observation, m.admission!.documents, s),
    readSource: async (source: typeof input.manifest.sources[number], s: AbortSignal) => {
      assert.equal(source.kind, "image"); if (source.kind !== "image") throw Error("REVIEW_MUST_NOT_BE_READ_AS_SUCCESS");
      return { id: source.id, kind: "image" as const, ...await vision.readLabelCandidate(source.task, s) };
    } };
  const assembly = new LabelProductAssembly(deps), out = await assembly.run(input, signal);
  assert.equal(out.status, "review"); if (out.status !== "review") throw Error("REVIEW_EXPECTED");
  assert.ok(out.codes.includes("TEXT.LABEL_EVIDENCE_UNCERTAIN"));
  const raw = await remote.read(out.evidenceKey, 8388608, signal); assert.ok(raw);
  const assembled = JSON.parse(Buffer.from(raw).toString("utf8"));
  assert.equal(assembled.result.codec, "label-product-assembly/2");
  assert.equal(assembled.result.formula.servingsPerContainer, null);
  assert.deepEqual(assembled.result.packaging.servingsPerContainer.claims.map((c: any) => c.value), ["3", "12"]);
  assert.ok(assembled.result.warnings.some((w: any) => w.code === "PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT"));
  const collect = new CollectLabelProduct({ ...deps, assembly, registry });
  assert.equal((await collect.run({ join: input, evidenceKey: out.evidenceKey }, signal)).status, "review");
  assert.equal(await registry.read(input.manifest.operationId), null);
  for (const r of oldReviews) assert.deepEqual(await reviews.read(r.reviewId), r);
  assert.equal(sha256(await readFile(join(live, "database-evidence.json"))), sha256(snapshotBytes));
  const document = TextDocumentSchema.parse(JSON.parse(Buffer.from((await artifacts.resolve(text.task.source.document, input.manifest.observation, signal)).bytes).toString("utf8")));
  const claims = assembled.result.packaging.servingsPerContainer.claims;
  for (const c of claims) assert.equal(document.text.slice(c.quote.start, c.quote.end), c.quote.text);
  proof.realCase = { status: out.status, codes: out.codes, count: assembled.result.formula.servingsPerContainer,
    warningCodes: assembled.result.warnings.map((w: any) => w.code), realProductRows: 0, oldReviewsUnchanged: true,
    oldSnapshotUnchanged: true, originalVisionRowsVerified: verified.candidate.formula!.columns[0]!.rows.length };
  proof.sourceReads = sourceReads; proof.oldR2Writes = 0; proof.newOutputWrites = outputWrites; proof.outputPrefix = outputPrefix;
  await writeFile(join(root, "assembly.json"), raw, { mode: 0o600, flag: "wx" });
  proof.status = "passed";
} finally {
  oldStore?.close(); outputStore?.close(); await db?.end();
  if (started) { await exec("docker", ["stop", "--time", "10", container]); proof.databaseStoppedRetained = true; }
  await writeFile(join(root, "proof.json"), JSON.stringify(proof, null, 2), { mode: 0o600, flag: "wx" }); console.log(JSON.stringify(proof));
}
