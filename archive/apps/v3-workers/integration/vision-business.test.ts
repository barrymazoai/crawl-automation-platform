import { createServer as httpsServer } from "node:https";
import { createServer as httpServer } from "node:http";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/common";
import { CodexVisionProvider, PostgresVisionRegistry, screenKeywords, RegisteredOcrEvidence, VisionHandoff, LocalVisionEvidenceStore } from "@crawl-automation/v3-vision";
import { observationIdentity, fingerprintOcrInput, processingIdentity, acquisitionFingerprintMaterial, type Observation, type VisionTask, type OcrInput, type FileOcrPlan } from "@crawl-automation/v3-contracts";
import { acquiredImageId, FILE_CONFIG_FINGERPRINT } from "@crawl-automation/v3-acquisition";
import { png as sourcePng, pageInput, sign } from "../../../packages/v3-acquisition/src/testing.fixture.js";
import { setup, signal, fixture as ocrFixture, MemoryObjects } from "../../../packages/v3-results/src/testing.fixture.js";
import { ArtifactResolver, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { png } from "../../../packages/v3-ocr/src/testing.fixture.js";
import { MultipartOcr } from "@crawl-automation/v3-ocr";
import { PostgresResultRegistry, OcrResultHandoff, FileCompletionJournal } from "@crawl-automation/v3-results";
import { digest } from "@crawl-automation/v3-vision";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { PostgresCollectedProducts, collectedHash, PostgresMixedCollectedProducts, mixedCollectedHash } from "@crawl-automation/v3-product";
import { startTestDatabase } from "../../v3-api/integration/postgres.js";
import { inputFor as pdfInputFor, nutritionPdf } from "../../../packages/v3-pdf/integration/helpers.js";
import { fingerprintPdfInput } from "@crawl-automation/v3-pdf";
import { PdfActivityOutcomeSchema, type PdfInput } from "@crawl-automation/v3-contracts";
import { textFingerprint, type ProductEvidenceJoin } from "@crawl-automation/v3-contracts";
import { TextModule, TextHandoff, PostgresTextRegistry, ResolveTextReceipt, TextEvidence } from "@crawl-automation/v3-text";
import { fixture as textFixture } from "../../../packages/v3-text/src/testing.fixture.js";

const exec = promisify(execFile), entry = resolve("dist/vision-worker.js");
const fakeHost = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com", bucket = "synthetic-only", prefix = `business-vision/${randomUUID()}`;
const objects = new Map<string, Buffer>(), children: ChildProcess[] = [];
let root: string, codexHome: string, executable: string, port: number, writes = 0, denyResults = false;
let resultUrl: string, reviewUrl: string, collectionUrl: string;
let db: Awaited<ReturnType<typeof startTestDatabase>>, temporal: TestWorkflowEnvironment;
let s3: ReturnType<typeof httpsServer>, workflow: Worker, running: Promise<void>;
let metadata: { buildId: string; compatibility: string }, queue: string;
let keywordMetadata: typeof metadata, keywordQueue: string;
type ProductRole = { role: string; capability: string; compatibility: string; buildId: string };
let productRoles: ProductRole[], productWorkflowRole: ProductRole, mixedWorkflowRole: ProductRole, savedWorkflowRole: ProductRole;
let collectorChild: ChildProcess, productWorkflowChild: ChildProcess;
let ocrServer: ReturnType<typeof httpServer>, ocrProvider: MultipartOcr, ocrEndpoint: string, ocrCalls = 0, ocrMetadata: typeof metadata;
let acquisitionRoles: ProductRole[], sourceCalls = 0;
let ocrForceNoLabel = false;
const sourceFiles = new Map<string, Buffer>();
const blockedSources = new Set<string>(), sourceReleases = new Map<string, () => void>();
let blockedPdfFragment: string | null = null;
const pdfReadReleases = new Set<() => void>();
const roleQueue = (role: ProductRole) => `v3.${role.capability}.v1.${role.compatibility}`;
const keywordEntry = resolve("dist/keyword-worker.js");
const pathFor = (key: string) => `/${bucket}/${prefix}/${key}`;
const codexConfig = (host: string) => ({ settings: { provider: "fixture", model: "fixture-model", reasoningEffort: "high" },
  executable, codexHome, workRoot: join(root, host, "codex-work"), timeoutMs: 10000, runtimeProfileVersion: "business-fixture/1" });
async function executions() {
  try { return (await readFile(join(codexHome, "executions.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function config(host: string) {
  const path = join(root, `${host}-vision.json`);
  await writeFile(path, JSON.stringify({ codex: codexConfig(host), storageId: "fixture-r2/1",
    cacheRoot: join(root, host, "cache"), ocrJournalRoot: join(root, host, "ocr-journal"), visionLocalRoot: join(root, host, "vision-evidence"),
    r2: { endpoint: `https://${fakeHost}`, bucket, prefix, timeoutMs: 2000 },
    r2Credentials: { accessKeyId: "synthetic-key", secretAccessKey: "synthetic-secret" },
    resultDatabase: { connectionString: resultUrl, tls: false }, reviewDatabase: { connectionString: reviewUrl, tls: false },
  }), { mode: 0o600 }); return path;
}
async function keywordConfig(host: string) {
  const path = await config(host), data = JSON.parse(await readFile(path, "utf8"));
  delete data.codex; data.keywordLocalRoot = data.visionLocalRoot; delete data.visionLocalRoot;
  await writeFile(path, JSON.stringify(data), { mode: 0o600 }); return path;
}
async function productConfig(host: string, collect = false) {
  const path = await config(host), data = JSON.parse(await readFile(path, "utf8"));
  delete data.codex; data.productLocalRoot = data.visionLocalRoot; delete data.visionLocalRoot;
  if (collect) data.collectionDatabase = { connectionString: collectionUrl, tls: false };
  await writeFile(path, JSON.stringify(data), { mode: 0o600 }); return path;
}
async function ocrConfig(host: string) {
  const path = await config(host), data = JSON.parse(await readFile(path, "utf8"));
  delete data.codex; delete data.visionLocalRoot; data.journalRoot = data.ocrJournalRoot; delete data.ocrJournalRoot;
  data.provider = { endpoint: ocrEndpoint, allowLoopbackHttp: true, minScore: 0.3, provider: "synthetic-http/1" };
  await writeFile(path, JSON.stringify(data), { mode: 0o600 }); return path;
}
async function acquisitionConfig(host: string, plans: FileOcrPlan[]) {
  const oldPath = await config(host), old = JSON.parse(await readFile(oldPath, "utf8")), path = join(root, `${host}-acquisition.json`);
  await writeFile(path, JSON.stringify({ cacheRoot: join(root, host, "files"), journalRoot: join(root, host, "journal"),
    r2: old.r2, r2Credentials: old.r2Credentials, reviewDatabase: old.reviewDatabase,
    sources: plans.map(p => ({ owner: observationIdentity(p.acquire), resourceId: p.acquire.resourceId, binding: p.acquire.binding,
      url: `https://files.example/${p.acquire.resourceId}?token=private-source-canary`, allowedOrigins: ["https://files.example"], expiresAt: "2099-01-01T00:00:00Z" })) }), { mode: 0o600 });
  return path;
}
async function launchAcquisition(host: string, role: ProductRole, plans: FileOcrPlan[] = []) {
  const runtime = join(root, `${host}-worker.json`);
  await writeFile(runtime, JSON.stringify({ role: role.role, capability: role.capability, compatibility: role.compatibility, contractVersion: 1,
    expectedBuildId: role.buildId, hostId: host, namespace: "default", address: temporal.address, transport: { mode: "local" },
    concurrency: 2, shutdownGraceMs: 2000, shutdownForceMs: 5000 }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", resolve("integration/fixtures/acquisition-loopback.mjs"), resolve("dist/acquisition-worker.js")], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, "cert.pem"), V3_TEST_S3_PORT: String(port),
      V3_ACQUISITION_LIVE_ENABLED: "true", V3_ACQUISITION_CONFIG: await acquisitionConfig(host, plans),
      V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: runtime }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child); let logs = "";
  child.stdout!.on("data", b => { logs = (logs + String(b)).slice(-20000); }); child.stderr!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  await vi.waitFor(() => { if (child.exitCode !== null) throw Error(logs); expect(logs).toContain('"event":"WORKER_RUNNING"'); }, { timeout: 15000 });
  return child;
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "v3-vision-business-"));
  codexHome = join(root, "codex-profile"); await mkdir(codexHome, { mode: 0o700 });
  await writeFile(join(codexHome, "scenario"), "ok", { mode: 0o600 });
  executable = join(root, "fixture-codex.mjs");
  await writeFile(executable, (await readFile(resolve("integration/fixtures/business-vision-codex.mjs"), "utf8")).replace("#!/usr/bin/env node", `#!${process.execPath}`));
  await chmod(executable, 0o700);
  db = await startTestDatabase({ tcp: true });
  for (const [role, table] of [["vision_result", "processing_result"], ["vision_review", "review_record"], ["product_collection", "collected_product"]]) {
    const password = randomUUID();
    await db.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await db.pool.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT ON ${table} TO ${role}`);
    const url = new URL(db.databaseUrl!); url.username = role!; url.password = password;
    if (role === "vision_result") resultUrl = url.href; else if (role === "vision_review") reviewUrl = url.href; else collectionUrl = url.href;
  }
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${fakeHost}`,
    "-addext", `subjectAltName=DNS:${fakeHost},DNS:files.example`, "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")]);
  s3 = httpsServer({ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) }, (req, res) => {
    const key = new URL(req.url!, "https://fixture").pathname;
    if (req.headers.host?.split(":")[0] === "files.example") {
      sourceCalls++; const bytes = sourceFiles.get(key);
      const send = () => { res.writeHead(bytes ? 200 : 404, { "Content-Type": "image/png" }); res.end(bytes ?? "missing"); };
      if (blockedSources.has(key)) sourceReleases.set(key, send); else send(); return;
    }
    const fail = (status: number, code: string) => { res.writeHead(status, { "Content-Type": "application/xml" }); res.end(`<Error><Code>${code}</Code></Error>`); };
    if (!key.startsWith(`/${bucket}/${prefix}/`) || !req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) return fail(403, "AccessDenied");
    if (req.method === "GET") {
      const data = objects.get(key); if (!data) return fail(404, "NoSuchKey");
      if (blockedPdfFragment && key.includes(blockedPdfFragment) && key.endsWith("output.png")) {
        pdfReadReleases.add(() => { res.writeHead(200, { "Content-Length": data.length }); res.end(data); }); return;
      }
      res.writeHead(200, { "Content-Length": data.length }); res.end(data); return;
    }
    if (req.method !== "PUT" || req.headers["if-none-match"] !== "*") return fail(403, "AccessDenied");
    writes++;
    const chunks: Buffer[] = []; req.on("data", b => chunks.push(b)); req.on("end", () => {
      if (denyResults && key.endsWith("/completion.json")) return fail(503, "ServiceUnavailable");
      if (objects.has(key)) return fail(412, "PreconditionFailed");
      objects.set(key, Buffer.concat(chunks)); res.writeHead(200, { ETag: '"fixture"' }); res.end();
    });
  });
  await new Promise<void>((r, reject) => { s3.once("error", reject); s3.listen(0, "127.0.0.1", r); });
  const address = s3.address(); if (!address || typeof address === "string") throw Error(); port = address.port;
  ocrServer = httpServer((req, res) => {
    ocrCalls++; const chunks: Buffer[] = []; req.on("data", b => chunks.push(b)); req.on("end", () => {
      const bytes = Buffer.concat(chunks), failed = bytes.includes(Buffer.from("FAIL_OCR"));
      res.writeHead(failed ? 500 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: ocrForceNoLabel || bytes.includes(Buffer.from("NO_LABEL")) ? "Marketing only" : "Supplement Facts Ingredients", lines: [] }));
    });
  });
  await new Promise<void>((r, reject) => { ocrServer.once("error", reject); ocrServer.listen(0, "127.0.0.1", r); });
  const httpAddress = ocrServer.address(); if (!httpAddress || typeof httpAddress === "string") throw Error();
  ocrEndpoint = `http://127.0.0.1:${httpAddress.port}/ocr`;
  ocrProvider = new MultipartOcr({ endpoint: ocrEndpoint, allowLoopbackHttp: true, minScore: 0.3, provider: "synthetic-http/1" });
  ocrMetadata = JSON.parse((await exec(process.execPath, [resolve("dist/ocr-worker.js"), "--list"], { env: { ...process.env,
    V3_OCR_LIVE_ENABLED: "true", V3_OCR_CONFIG: await ocrConfig("ocr-metadata") } })).stdout)[0];
  const settings = await config("metadata");
  metadata = JSON.parse((await exec(process.execPath, [entry, "--list"], { env: { ...process.env, V3_VISION_LIVE_ENABLED: "true", V3_VISION_CONFIG: settings } })).stdout)[0];
  keywordMetadata = JSON.parse((await exec(process.execPath, [keywordEntry, "--list"], { env: { ...process.env,
    V3_KEYWORD_LIVE_ENABLED: "true", V3_KEYWORD_CONFIG: await keywordConfig("keyword-metadata") } })).stdout)[0];
  keywordQueue = `v3.ocr.keywords.v1.${keywordMetadata.compatibility}`;
  productRoles = JSON.parse((await exec(process.execPath, [resolve("dist/product-worker.js"), "--list"], { env: { ...process.env,
    V3_PRODUCT_LIVE_ENABLED: "true", V3_PRODUCT_CONFIG: await productConfig("product-metadata") } })).stdout);
  const workflowRoles: ProductRole[] = JSON.parse((await exec(process.execPath, [resolve("dist/product-workflow-worker.js"), "--list"])).stdout);
  productWorkflowRole = workflowRoles.find(r => r.role === "product-images-workflow")!;
  mixedWorkflowRole = workflowRoles.find(r => r.role === "product-evidence-workflow")!;
  savedWorkflowRole = workflowRoles.find(r => r.role === "product-saved-workflow")!;
  acquisitionRoles = JSON.parse((await exec(process.execPath, [resolve("dist/acquisition-worker.js"), "--list"], { env: { ...process.env,
    V3_ACQUISITION_LIVE_ENABLED: "true", V3_ACQUISITION_CONFIG: await acquisitionConfig("acquisition-metadata", []) } })).stdout);
  expect(await executions()).toHaveLength(0);
  queue = `v3.codex.vision.v1.${metadata.compatibility}`;
  temporal = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false,
    executable: process.env.V3_TEST_TEMPORAL_CLI ? { type: "existing-path", path: process.env.V3_TEST_TEMPORAL_CLI } : { type: "cached-download", version: "v1.8.3" } } });
  workflow = await Worker.create({ connection: temporal.nativeConnection, taskQueue: "business-vision-fixture-workflow", workflowBundle: { codePath: resolve(".local/test-dist/vision-workflows.cjs") } });
  running = workflow.run();
  productWorkflowChild = await launchProduct("product-workflow", productWorkflowRole);
  await launchProduct("product-assembly", productRoles.find(r => r.role === "product-images-assembly")!);
  collectorChild = await launchProduct("product-collector", productRoles.find(r => r.role === "product-collect")!);
});
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try { await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 10000 }); }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}
afterAll(async () => {
  await Promise.allSettled(children.map(stop));
  if (workflow) { workflow.shutdown(); await running; }
  if (db) await writeFile(join(root, "database-proof.json"), JSON.stringify({ executions: await executions(), writes, ocrCalls, sourceCalls,
    results: (await db.pool.query("SELECT operation_id,record_hash FROM processing_result")).rows,
    collected: (await db.pool.query("SELECT operation_id,record_hash,record FROM collected_product")).rows,
    reviews: (await db.pool.query("SELECT review_id,record->'failure' AS failure FROM review_record")).rows }, null, 2));
  await temporal?.teardown(); await db?.close();
  if (s3) { s3.closeAllConnections(); await new Promise<void>(r => s3.close(() => r())); }
  if (ocrServer) { ocrServer.closeAllConnections(); await new Promise<void>(r => ocrServer.close(() => r())); }
  await ocrProvider?.close();
  console.log(`Business vision isolated evidence: ${root}; real model/R2 requests: 0`);
});
async function launchProduct(host: string, role: ProductRole) {
  const workflowRole = role.role === "product-images-workflow" || role.role === "product-evidence-workflow" || role.role === "product-saved-workflow", runtime = join(root, `${host}-worker.json`);
  await writeFile(runtime, JSON.stringify({ role: role.role, capability: role.capability, compatibility: role.compatibility,
    contractVersion: 1, expectedBuildId: role.buildId,
    hostId: host, namespace: "default", address: temporal.address, transport: { mode: "local" }, concurrency: 2,
    shutdownGraceMs: 2000, shutdownForceMs: 5000 }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", resolve("integration/fixtures/s3-loopback.mjs"),
    resolve(workflowRole ? "dist/product-workflow-worker.js" : "dist/product-worker.js")], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, "cert.pem"), V3_TEST_S3_PORT: String(port),
      ...(!workflowRole ? { V3_PRODUCT_LIVE_ENABLED: "true", V3_PRODUCT_CONFIG: await productConfig(host, role.role === "product-collect" || role.role === "product-evidence-collect") } : {}),
      V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: runtime }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child); let logs = "";
  child.stdout!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  child.stderr!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  await vi.waitFor(() => { if (child.exitCode !== null) throw Error(logs); expect(logs).toContain('"event":"WORKER_RUNNING"'); }, { timeout: 15000 });
  return child;
}
async function launch(host: string, kind: "vision" | "keywords" | "ocr" = "vision") {
  const keywords = kind === "keywords", ocr = kind === "ocr", meta = ocr ? ocrMetadata : keywords ? keywordMetadata : metadata;
  const settings = await (ocr ? ocrConfig(host) : keywords ? keywordConfig(host) : config(host)), runtime = join(root, `${host}-worker.json`);
  await writeFile(runtime, JSON.stringify({ role: ocr ? "ocr-file" : keywords ? "ocr-keywords" : "codex-vision", capability: ocr ? "ocr.file" : keywords ? "ocr.keywords" : "codex.vision", contractVersion: 1,
    compatibility: meta.compatibility, expectedBuildId: meta.buildId, hostId: host, namespace: "default", address: temporal.address,
    transport: { mode: "local" }, concurrency: 2, shutdownGraceMs: 2000, shutdownForceMs: 5000 }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", resolve("integration/fixtures/s3-loopback.mjs"), ocr ? resolve("dist/ocr-worker.js") : keywords ? keywordEntry : entry], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, "cert.pem"), V3_TEST_S3_PORT: String(port),
      ...(ocr ? { V3_OCR_LIVE_ENABLED: "true", V3_OCR_CONFIG: settings } : keywords ? { V3_KEYWORD_LIVE_ENABLED: "true", V3_KEYWORD_CONFIG: settings } : { V3_VISION_LIVE_ENABLED: "true", V3_VISION_CONFIG: settings }),
      V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: runtime }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child); let logs = "";
  child.stdout!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  child.stderr!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  await vi.waitFor(() => { if (child.exitCode !== null) throw Error(logs); expect(logs).toContain('"event":"WORKER_RUNNING"'); }, { timeout: 15000 });
  return child;
}

async function input(owner?: Observation, text = "Supplement Facts"): Promise<VisionTask> {
  const f = await setup(new PostgresResultRegistry(db.pool));
  if (owner) {
    Object.assign(f.input, owner); Object.assign(f.input.file, { observationId: owner.observationId, sourceId: owner.sourceId, listingId: owner.listingId, variantId: owner.variantId });
    f.input.inputFingerprint = fingerprintOcrInput(f.input, digest);
    await f.local.retain(f.input.file, f.bytes, signal());
  }
  const output = { ...processingIdentity(f.input), provider: f.output.provider, text };
  await f.handoff.capture(f.input, output, signal());
  await f.handoff.uploadMissing(f.input, signal());
  await f.handoff.register(f.input, signal());
  for (const [key, data] of f.remote.data) objects.set(pathFor(key), Buffer.from(data));
  return { input: { operationId: `vision-${randomUUID()}`, selection: screenKeywords({
    observation: observationIdentity(f.input), image: f.input.file, ocrOperationId: f.input.operationId, text: output.text }) },
    ...CodexVisionProvider.describe(codexConfig("input")) };
}
const start = (task: VisionTask) => temporal.client.workflow.start("BusinessVisionProbe", {
  taskQueue: "business-vision-fixture-workflow", workflowId: `business-vision-${randomUUID()}`,
  args: [{ task, queue }], workflowExecutionTimeout: "1 minute" });

it("compiled business Worker registers, then empty-cache replacement replays with zero new calls or writes", async () => {
  const task = await input(), handle = await start(task);
  await vi.waitFor(async () => expect((await handle.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes)).toBe(true));
  expect(await executions()).toHaveLength(0);
  const first = await launch("vision-a");
  const outcome = await handle.result();
  expect(outcome).toMatchObject({ status: "registered", candidateStatus: "candidate" });
  expect(await executions()).toHaveLength(1);
  const record = await new PostgresVisionRegistry(db.pool).read(task.input.operationId);
  expect(record!.status).toBe("candidate");
  const envelope = JSON.parse(objects.get(pathFor(record!.result.objectKey))!.toString());
  expect(JSON.parse(envelope.raw).ingredients[0].name).toBe("Ginger root");
  await stop(first);
  const second = await launch("vision-b"), before = writes;
  expect(await (await start(task)).result()).toEqual(outcome);
  expect(await executions()).toHaveLength(1); expect(writes).toBe(before);
  await stop(second);
});
it("independent mixed Worker consumes registered text and image evidence without model reruns or collection writes", async () => {
  const f = textFixture("Other ingredients: Water");
  const supported = { ...f.provider.supported, implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2 as const };
  const task = { ...f.input, ...supported }; task.inputFingerprint = textFingerprint(task, digest);
  let textCalls = 0;
  const provider = { ...f.provider, supported, interpret: async () => { textCalls++; return JSON.stringify({ formula: null,
    ingredients: { items: [{ quote: { fromLine: 1, toLine: 1, text: "Water" }, role: "other", parentNutrientIndex: null }] },
    excluded: [{ quote: { fromLine: 1, toLine: 1, text: "Other ingredients:" }, reason: "heading" }], issues: [] }); } };
  const handoff = new TextHandoff(f.local, f.remote, new PostgresTextRegistry(db.pool), f.evidence, "fixture-r2/1");
  expect(await new TextModule({ ...f.deps, provider, handoff }).run(task, signal())).toMatchObject({ status: "registered" });
  for (const [key, bytes] of f.remote.data) objects.set(pathFor(key), Buffer.from(bytes));
  const visionTask = await input(f.owner), vision = await launch("mixed-source-vision");
  try { expect(await (await start(visionTask)).result()).toMatchObject({ status: "registered" }); }
  finally { await stop(vision); }
  const beforeModels = (await executions()).length;
  const beforeCollection = (await db.pool.query("SELECT count(*) FROM collected_product")).rows[0].count;
  const mixed: ProductEvidenceJoin = { manifest: { operationId: `mixed-${randomUUID()}`, observation: f.owner, sources: [
    { id: "page", kind: "text", required: true, task }, { id: "label", kind: "image", required: true, task: visionTask },
  ] }, states: [{ id: "page", status: "registered" }, { id: "label", status: "registered" }] };
  const role = productRoles.find(r => r.role === "product-evidence-assembly")!;
  const run = (task: ProductEvidenceJoin) => temporal.client.workflow.execute("BusinessMixedProbe", {
    taskQueue: "business-vision-fixture-workflow", workflowId: `mixed-probe-${randomUUID()}`,
    args: [{ task, queue: roleQueue(role) }], workflowExecutionTimeout: "1 minute" });
  const first = await launchProduct("mixed-a", role);
  let result: { status: string; evidenceKey: string };
  try {
    result = await run(mixed); expect(result.status).toBe("ready");
    const evidence = JSON.parse(objects.get(pathFor(result.evidenceKey))!.toString()).result;
    expect(evidence.codec).toBe("product-evidence/1"); expect(evidence.provenance).toHaveLength(2);
    expect(evidence.ingredients.find((i: { role: string }) => i.role === "other").name.citations[0]).toMatchObject({ kind: "text", sourceId: "page", start: 19, end: 24 });
    expect(evidence.formula.columns[0].nutrients[0].name.citations[0].kind).toBe("image");
  } finally { await stop(first); }
  const second = await launchProduct("mixed-b", role), beforeWrites = writes;
  try {
    expect(await run(mixed)).toEqual(result!); expect(writes).toBe(beforeWrites);
    const source = objects.get(pathFor(f.source.objectKey))!;
    objects.set(pathFor(f.source.objectKey), Buffer.from("corrupted source"));
    try { expect(await run(mixed)).toMatchObject({ status: "review", codes: ["MIXED.EVIDENCE_UNVERIFIED", "MIXED.HANDOFF_UNVERIFIED"] }); }
    finally { objects.set(pathFor(f.source.objectKey), source); }
    expect(textCalls).toBe(1); expect(await executions()).toHaveLength(beforeModels);
    expect((await db.pool.query("SELECT count(*) FROM collected_product")).rows[0].count).toBe(beforeCollection);
  } finally { await stop(second); }
});
it("mixed parent streams independent sources, waits without source Workers, and collects one immutable mixed snapshot", async () => {
  const f = textFixture("Other ingredients: Water"), reviews = new PostgresReviews(db.pool);
  const supported = { ...f.provider.supported, implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2 as const };
  const task = { ...f.input, ...supported }; task.inputFingerprint = textFingerprint(task, digest);
  let textCalls = 0;
  const provider = { ...f.provider, supported, interpret: async () => { textCalls++; return JSON.stringify({ formula: null,
    ingredients: { items: [{ quote: { fromLine: 1, toLine: 1, text: "Water" }, role: "other", parentNutrientIndex: null }] },
    excluded: [{ quote: { fromLine: 1, toLine: 1, text: "Other ingredients:" }, reason: "heading" }], issues: [] }); } };
  const handoff = new TextHandoff(f.local, f.remote, new PostgresTextRegistry(db.pool), f.evidence, "fixture-r2/1");
  const textModule = new TextModule({ ...f.deps, provider, handoff, reviews }), receipt = new ResolveTextReceipt({ results: handoff, local: f.local, reviews });
  const id = randomUUID(), textQueue = `mixed-text-${id}`, receiptQueue = `mixed-receipt-${id}`;
  // Real text core behind a test Activity adapter; compiled text Worker is covered by text-business.test.ts.
  const textWorker = await Worker.create({ connection: temporal.nativeConnection, taskQueue: textQueue, activities: {
    interpretText: async (raw: unknown) => { const result = await textModule.run(raw, signal());
      for (const [key, bytes] of f.remote.data) objects.set(pathFor(key), Buffer.from(bytes)); return result; },
  } });
  const textRunning = textWorker.run(), visionTask = await input(f.owner), beforeModels = (await executions()).length;
  const vision = await launch("mixed-parent-vision"), assemblyRole = productRoles.find(r => r.role === "product-evidence-assembly")!, collectRole = productRoles.find(r => r.role === "product-evidence-collect")!;
  const assembly = await launchProduct("mixed-parent-assembly", assemblyRole), collector = await launchProduct("mixed-parent-collect", collectRole);
  const parent = await launchProduct("mixed-parent-workflow", mixedWorkflowRole);
  const manifest = { operationId: `mixed-parent-${id}`, observation: f.owner, sources: [
    { id: "page", kind: "text" as const, required: true, task }, { id: "label", kind: "image" as const, required: true, task: visionTask },
  ] };
  const plan = { manifest, queues: { text: textQueue, textReceipts: receiptQueue, vision: queue, assembly: roleQueue(assemblyRole), collection: roleQueue(collectRole) } };
  const handle = await temporal.client.workflow.start("MixedProductWorkflow", { taskQueue: roleQueue(mixedWorkflowRole),
    workflowId: `mixed-parent-${id}`, args: [plan], workflowExecutionTimeout: "1 minute" });
  let receiptWorker: Worker | undefined, receiptRunning: Promise<void> | undefined, textStopped = false;
  try {
    await vi.waitFor(async () => {
      expect(await new PostgresVisionRegistry(db.pool).read(visionTask.input.operationId)).not.toBeNull();
      const history = await handle.fetchHistory();
      expect(history.events?.some(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "resolveTextReceipt")).toBe(true);
    }, { timeout: 15000 });
    expect((await handle.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "assembleProductEvidence")).toBe(false);
    expect(await new PostgresMixedCollectedProducts(db.pool).read(manifest.operationId)).toBeNull();
    textWorker.shutdown(); await textRunning; textStopped = true; await stop(vision);
    receiptWorker = await Worker.create({ connection: temporal.nativeConnection, taskQueue: receiptQueue,
      activities: { resolveTextReceipt: (raw: unknown) => receipt.run(raw, signal()) } });
    receiptRunning = receiptWorker.run();
    const out = await handle.result(); expect(out).toMatchObject({ status: "collected", operationId: manifest.operationId });
    const r = (await new PostgresMixedCollectedProducts(db.pool).read(manifest.operationId))!;
    expect(r.codec).toBe("collected-product/2"); expect(out.recordHash).toBe(mixedCollectedHash(r));
    expect(r.ingredients.find(i => i.role === "other")!.name.citations[0]!.kind).toBe("text");
    expect(r.formula.columns[0]!.nutrients[0]!.name.citations[0]!.kind).toBe("image");
    expect(textCalls).toBe(1); expect(await executions()).toHaveLength(beforeModels + 1);
    await expect(db.pool.query("UPDATE collected_product SET record_hash=record_hash WHERE operation_id=$1", [manifest.operationId])).rejects.toThrow("cannot be modified");
    await expect(db.pool.query("DELETE FROM collected_product WHERE operation_id=$1", [manifest.operationId])).rejects.toThrow("cannot be modified");
    await stop(collector);
    const replacement = await launchProduct("mixed-parent-collect-replacement", collectRole), beforeWrites = writes;
    const mixedJoin: ProductEvidenceJoin = { manifest, states: [{ id: "page", status: "registered" }, { id: "label", status: "registered" }] };
    const collect = () => temporal.client.workflow.execute("BusinessMixedCollectProbe", { taskQueue: "business-vision-fixture-workflow",
      workflowId: `mixed-collect-${randomUUID()}`, args: [{ task: { join: mixedJoin, evidenceKey: out.evidenceKey }, queue: roleQueue(collectRole) }] });
    try {
      expect(await collect()).toEqual(out); expect(writes).toBe(beforeWrites);
      const original = objects.get(pathFor(f.source.objectKey))!; objects.set(pathFor(f.source.objectKey), Buffer.from("broken"));
      try { expect(await collect()).toMatchObject({ status: "review" }); } finally { objects.set(pathFor(f.source.objectKey), original); }
      const different = { ...r, operationId: `conflict-${id}` };
      await expect(new PostgresMixedCollectedProducts(db.pool).append(different)).rejects.toThrow("RESULT_CONFLICT");
      expect(textCalls).toBe(1); expect(await executions()).toHaveLength(beforeModels + 1);
      await writeFile(join(root, "mixed-product-history.json"), JSON.stringify(await handle.fetchHistory()));
    } finally { await stop(replacement); }
  } finally {
    if (!textStopped) { textWorker.shutdown(); await textRunning; }
    if (receiptWorker) { receiptWorker.shutdown(); await receiptRunning; }
    await Promise.all([vision, assembly, collector, parent].map(stop));
  }
}, 45000);
it("saved HTML, PDF pages and raw images stream through preparation and collection with retained nonmatches/failures", async () => {
  const base = textFixture(), local = new MemoryObjects(), reviews = new PostgresReviews(db.pool);
  const remote: ObjectStore = { read: async (key, max) => { const b = objects.get(pathFor(key)); if (b && b.length > max) throw Error("too large"); return b ?? null; },
    create: async (key, bytes) => { writes++; if (objects.has(pathFor(key))) return "exists"; objects.set(pathFor(key), Buffer.from(bytes)); return "created"; } };
  const evidence = new TextEvidence(new ArtifactResolver({ read: async () => null, retain: async () => {} }, remote), { inspect: async () => { throw Error("prepared text only"); } });
  const handoff = new TextHandoff(local, remote, new PostgresTextRegistry(db.pool), evidence, "fixture-r2/1");
  let textCalls = 0;
  const supported = { ...base.provider.supported, implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2 as const };
  const q = (text: string) => ({ fromLine: 1, toLine: 1, text });
  const provider = { ...base.provider, supported, interpret: async (request: { operationId: string }) => { textCalls++; return JSON.stringify({
    formula: request.operationId.startsWith("pdf-text-") ? null : { servingSize: q("1 capsule"), nutrients: [{ name: q("Blend"), amount: q("10 mg"), dailyValue: null }] },
    ingredients: { items: [{ quote: q("Water"), role: "other", parentNutrientIndex: null }] }, excluded: [{ quote: q("Other ingredients:"), reason: "heading" }], issues: [] }); } };
  const textModule = new TextModule({ provider, handoff, reviews, nodeId: "saved-test-text" }), receipt = new ResolveTextReceipt({ results: handoff, local, reviews });
  const textQueue = `saved-text-${randomUUID()}`, textWorker = await Worker.create({ connection: temporal.nativeConnection, taskQueue: textQueue,
    activities: { interpretText: (raw: unknown) => textModule.run(raw, signal()), resolveTextReceipt: (raw: unknown) => receipt.run(raw, signal()) } });
  const runningText = textWorker.run();
  const pageRole = acquisitionRoles.find(r => r.role === "page-prepare")!, pageTextRole = acquisitionRoles.find(r => r.role === "page-text-input")!;
  const assemblyRole = productRoles.find(r => r.role === "product-evidence-assembly")!, collectRole = productRoles.find(r => r.role === "product-evidence-collect")!;
  const pdfDefinitions = await pdfRoles(), pdfTextRole = pdfDefinitions.find(r => r.role === "pdf-text")!, pdfPrepareRole = pdfDefinitions.find(r => r.role === "pdf-text-input")!;
  const started = await Promise.all([launchProduct("saved-parent", savedWorkflowRole), launchProduct("saved-assembly", assemblyRole),
    launchProduct("saved-collect", collectRole), launchProduct("saved-ocr-receipt", productRoles.find(r => r.role === "ocr-receipt")!),
    launchAcquisition("saved-page", pageRole), launch("saved-ocr", "ocr"), launch("saved-keywords", "keywords"), launch("saved-vision")]);
  let pdfExtractor = await launchPdf("saved-pdf-extract", pdfTextRole); started.push(pdfExtractor);
  try {
    for (const mode of ["ok", "not_matched", "empty_required", "empty_optional", "all_not_matched", "pdf_ok", "pdf_empty_required", "pdf_empty_optional", "pdf_two_pages", "pdf_text_only"] as const) {
      const id = randomUUID(), owner = { ...base.owner, requestId: `req-${id}`, observationId: `obs-${id}`, listingId: `listing-${id}` };
      const pdfMode = mode.startsWith("pdf_"), empty = mode.includes("empty"), optional = mode.endsWith("optional");
      const html = pageInput(mode.startsWith("empty") ? "<script>ignored()</script>" : "<p>1 capsule Blend 10 mg Other ingredients: Water</p>");
      const page = sign({ ...html.input, ...owner, operationId: `page-${id}`, page: { ...html.input.page, observationId: owner.observationId, sourceId: owner.sourceId,
        listingId: owner.listingId, artifactId: `html-${id}`, objectKey: `captured/${id}.html`, producer: { ...html.input.page.producer, operationId: `capture-${id}` } } });
      objects.set(pathFor(page.page.objectKey), html.bytes);
      const ocrTask = automaticInput(mode.includes("not_matched") ? "NO_LABEL" : "", owner), visionOp = `vision-${id}`;
      const pdfBytes = nutritionPdf(mode === "pdf_two_pages" ? 2 : 1, empty ? "" : mode === "pdf_text_only"
        ? "BT /F1 12 Tf 40 340 Td (1 capsule Blend 10 mg Other ingredients: Water) Tj ET" : "BT /F1 12 Tf 40 340 Td (Other ingredients: Water) Tj ET");
      const pdfSources = Array.from({ length: mode === "pdf_two_pages" ? 2 : 1 }, (_, pageIndex) => {
        const extraction = { ...pdfInputFor(pdfBytes, "pdf.text", `extract-${id}-${pageIndex}`, pageIndex), ...owner };
        extraction.pdf = { ...extraction.pdf, observationId: owner.observationId, sourceId: owner.sourceId, listingId: owner.listingId, variantId: owner.variantId,
          artifactId: `pdf-${id}`, objectKey: `captured/${id}.pdf` };
        extraction.inputFingerprint = fingerprintPdfInput(extraction); objects.set(pathFor(extraction.pdf.objectKey), pdfBytes);
        return { id: `pdf-page-${pageIndex}`, kind: "pdf-text" as const, required: !optional,
          plan: { extraction, textOperationId: `${mode === "pdf_text_only" ? "pdf-full" : "pdf-text"}-${id}-${pageIndex}`, text: supported } };
      });
      const sources = [
        ...(pdfMode ? pdfSources : mode === "all_not_matched" ? [] : [{ id: "page", kind: "page" as const, required: !optional, plan: { page, textOperationId: `text-${id}`, text: supported } }]),
        ...(mode === "pdf_text_only" ? [] : [{ id: "label", kind: "ocr-image" as const, required: true, task: ocrTask, visionOperationId: visionOp, configFingerprint: CodexVisionProvider.describe(codexConfig("saved")).configFingerprint }]),
      ];
      const manifest = { operationId: `saved-${id}`, observation: owner, sources }, queues = { page: roleQueue(pageRole), pageText: roleQueue(pageTextRole),
        text: textQueue, textReceipts: textQueue, ocr: `v3.ocr.file.v1.${ocrMetadata.compatibility}`, ocrReceipts: roleQueue(productRoles.find(r => r.role === "ocr-receipt")!),
        keywords: keywordQueue, vision: queue, assembly: roleQueue(assemblyRole), collection: roleQueue(collectRole),
        ...(pdfMode ? { pdfText: roleQueue(pdfTextRole), pdfTextPrepare: roleQueue(pdfPrepareRole) } : {}) };
      const beforeOcr = ocrCalls, beforeVision = (await executions()).length, beforeText = textCalls;
      const handle = await temporal.client.workflow.start("SavedProductWorkflow", { taskQueue: roleQueue(savedWorkflowRole), workflowId: manifest.operationId,
        args: [{ manifest, queues }], workflowExecutionTimeout: "1 minute" });
      if (mode === "ok" || mode === "pdf_ok") {
        await vi.waitFor(async () => {
          expect(await new PostgresVisionRegistry(db.pool).read(visionOp)).not.toBeNull();
          expect((await handle.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes?.activityType?.name === (pdfMode ? "preparePdfText" : "preparePageText"))).toBe(true);
        }, { timeout: 15000 });
        expect(textCalls).toBe(beforeText); expect(await new PostgresMixedCollectedProducts(db.pool).read(manifest.operationId)).toBeNull();
        started.push(pdfMode ? await launchPdf("saved-pdf-prepare", pdfPrepareRole, false) : await launchAcquisition("saved-page-text", pageTextRole));
      }
      const out = await handle.result(), shouldSave = !["empty_required", "pdf_empty_required", "all_not_matched"].includes(mode);
      expect(out.status, JSON.stringify({ mode, out })).toBe(shouldSave ? "collected" : "review");
      expect(ocrCalls).toBe(beforeOcr + (mode === "pdf_text_only" ? 0 : 1)); expect((await executions()).length - beforeVision).toBe(mode.includes("not_matched") || mode === "pdf_text_only" ? 0 : 1);
      expect(textCalls - beforeText).toBe(empty || mode === "all_not_matched" ? 0 : mode === "pdf_two_pages" ? 2 : 1);
      const assembly = JSON.parse(objects.get(pathFor(out.evidenceKey))!.toString());
      expect(assembly.input.manifest.sources).toHaveLength(sources.length);
      if (mode.includes("not_matched")) expect(assembly.result.warnings).toContainEqual({ id: "label", code: "SCREEN.NO_KEYWORDS" });
      if (mode === "empty_optional") expect(assembly.result.warnings).toContainEqual({ id: "page", code: "PROCESSING.PAGE_EMPTY" });
      if (mode === "pdf_empty_optional") expect(assembly.result.warnings).toContainEqual({ id: "pdf-page-0", code: "PDF.TEXT_EMPTY" });
      if (pdfMode) expect(assembly.input.manifest.sources.filter((s: { kind: string }) => s.kind === "pdf-text")).toEqual(pdfSources);
      if (shouldSave) {
        const record = await new PostgresMixedCollectedProducts(db.pool).read(manifest.operationId); expect(record).not.toBeNull();
        if (pdfMode && !empty) {
          const textSources = record!.provenance.filter(p => p.kind === "text"); expect(textSources).toHaveLength(pdfSources.length);
          for (const p of textSources) {
            const task = p.record.input; if (task.source.kind !== "prepared") throw Error();
            const doc = JSON.parse(objects.get(pathFor(task.source.document.objectKey))!.toString());
            expect(doc.pageIndex).toBe(Number(p.id.split("-").at(-1))); expect(doc.source).toEqual(pdfSources[0]!.plan.extraction.pdf);
          }
          if (mode === "pdf_ok") {
            expect(record!.formula.columns[0]!.nutrients[0]!.name.citations.every(c => c.kind === "image")).toBe(true);
            expect(record!.ingredients.find(i => i.role === "other")!.name.citations.some(c => c.sourceId === "pdf-page-0")).toBe(true);
          }
          if (mode === "pdf_text_only") expect(record!.provenance.every(p => p.kind === "text")).toBe(true);
        }
      } else expect(await new PostgresMixedCollectedProducts(db.pool).read(manifest.operationId)).toBeNull();
      if (mode === "ok") {
        await stop(started[4]!); started.push(await launchAcquisition("saved-page-empty-replacement", pageRole));
        const beforeWrites = writes, beforeOcrReplay = ocrCalls, beforeTextReplay = textCalls, beforeVisionReplay = (await executions()).length;
        const replay = await temporal.client.workflow.execute("SavedProductWorkflow", { taskQueue: roleQueue(savedWorkflowRole),
          workflowId: `saved-replay-${id}`, args: [{ manifest, queues }], workflowExecutionTimeout: "1 minute" });
        expect(replay).toEqual(out); expect(writes).toBe(beforeWrites); expect(ocrCalls).toBe(beforeOcrReplay);
        expect(textCalls).toBe(beforeTextReplay); expect(await executions()).toHaveLength(beforeVisionReplay);
      }
      if (mode === "pdf_ok") {
        await stop(pdfExtractor); const replacement = await launchPdf("saved-pdf-no-engine", pdfTextRole, false); started.push(replacement);
        const beforeWrites = writes, beforeModels = textCalls, beforeVisionReplay = (await executions()).length, beforeOcrReplay = ocrCalls;
        const replay = await temporal.client.workflow.execute("SavedProductWorkflow", { taskQueue: roleQueue(savedWorkflowRole), workflowId: `pdf-saved-replay-${id}`,
          args: [{ manifest, queues }], workflowExecutionTimeout: "1 minute" });
        expect(replay).toEqual(out); expect(writes).toBe(beforeWrites); expect(textCalls).toBe(beforeModels);
        expect(await executions()).toHaveLength(beforeVisionReplay); expect(ocrCalls).toBe(beforeOcrReplay);
        expect(await readdir(join(root, "saved-pdf-no-engine", "attempts"))).toHaveLength(0);
        // Collector must revalidate raw PDF, not accept an existing collected row as proof.
        const key = pathFor(pdfSources[0]!.plan.extraction.pdf.objectKey), original = objects.get(key)!; objects.set(key, Buffer.from("corrupt PDF"));
        try {
          expect(await temporal.client.workflow.execute("BusinessMixedCollectProbe", { taskQueue: "business-vision-fixture-workflow", workflowId: `pdf-collect-check-${id}`,
            args: [{ task: { join: assembly.input, evidenceKey: out.evidenceKey }, queue: roleQueue(collectRole) }] })).toMatchObject({ status: "review" });
        } finally { objects.set(key, original); }
        expect(writes).toBe(beforeWrites); expect(textCalls).toBe(beforeModels);
        await stop(replacement); pdfExtractor = await launchPdf("saved-pdf-next-extract", pdfTextRole); started.push(pdfExtractor);
      }
      await writeFile(join(root, `saved-product-${mode}-history.json`), JSON.stringify(await handle.fetchHistory()));
    }
  } finally { textWorker.shutdown(); await runningText; await Promise.all(started.map(stop)); }
}, 90000);
it("failure and repeated delivery remain passive Review with one model execution", async () => {
  const worker = await launch("vision-failure"), task = await input(), before = (await executions()).length;
  await writeFile(join(codexHome, "scenario"), "fail");
  try {
    expect(await (await start(task)).result()).toMatchObject({ status: "review", automaticRetry: false });
    expect(await (await start(task)).result()).toMatchObject({ status: "review", automaticRetry: false });
    expect(await executions()).toHaveLength(before + 1);
    expect((await db.pool.query("SELECT record FROM review_record WHERE record->'failure'->>'operationId'=$1", [task.input.operationId])).rows).toHaveLength(2);
  } finally { await writeFile(join(codexHome, "scenario"), "ok"); await stop(worker); }
});
it("post-compute completion upload failure is not automatically re-published or re-executed", async () => {
  const worker = await launch("vision-handoff"), task = await input(), before = (await executions()).length;
  denyResults = true;
  try {
    expect(await (await start(task)).result()).toMatchObject({ status: "review", code: "VISION.HANDOFF_PENDING" });
    denyResults = false;
    const beforeWrites = writes;
    expect(await (await start(task)).result()).toMatchObject({ status: "review", code: "VISION.HANDOFF_PENDING" });
    expect(await executions()).toHaveLength(before + 1); expect(writes).toBe(beforeWrites);
    expect(await new PostgresVisionRegistry(db.pool).read(task.input.operationId)).toBeNull();
  } finally { denyResults = false; await stop(worker); }
});
it("wrong model fingerprint and no keyword match cannot trigger a model", async () => {
  const worker = await launch("vision-config"), task = await input(), before = (await executions()).length;
  try {
    expect(await (await start({ ...task, configFingerprint: "b".repeat(64) })).result()).toMatchObject({ status: "review", code: "VISION.CONFIG_MISMATCH" });
    const invalid = structuredClone(task); invalid.input.selection.status = "not_matched"; invalid.input.selection.matchedKeywords = [];
    await expect((await start(invalid)).result()).rejects.toThrow();
    expect(await executions()).toHaveLength(before);
  } finally { await stop(worker); }
});
it("concurrent products retain separate image ownership and child processes", async () => {
  const worker = await launch("vision-concurrent"), tasks = await Promise.all([input(), input()]), before = (await executions()).length;
  try {
    const outcomes = await Promise.all(tasks.map(async task => (await start(task)).result()));
    expect(outcomes).toEqual([expect.objectContaining({ status: "registered" }), expect.objectContaining({ status: "registered" })]);
    const runs = (await executions()).slice(before); expect(runs).toHaveLength(2);
    expect(new Set(runs.map(r => r.pid)).size).toBe(2); expect(new Set(runs.map(r => r.cwd)).size).toBe(2);
    for (const task of tasks) {
      const record = await new PostgresVisionRegistry(db.pool).read(task.input.operationId);
      expect(record!.input.selection.image.artifactId).toBe(task.input.selection.image.artifactId);
    }
  } finally { await stop(worker); }
});

async function product(tasks: VisionTask[], options: { initial?: boolean; waitMs?: number } = {}) {
  const first = tasks[0]!, manifest = { operationId: `product-${randomUUID()}`, observation: first.input.selection.observation,
    imageIds: tasks.map(t => t.input.selection.image.artifactId), configFingerprint: first.configFingerprint };
  const registrations = await Promise.all(tasks.map(t => new PostgresResultRegistry(db.pool).read(t.input.selection.ocrOperationId)));
  if (registrations.some(r => !r)) throw Error();
  const handle = await temporal.client.workflow.start("ProductImageWorkflow", { taskQueue: roleQueue(productWorkflowRole),
    workflowId: manifest.operationId, args: [{ manifest, queues: { keywords: keywordQueue, vision: queue,
      assembly: roleQueue(productRoles.find(r => r.role === "product-images-assembly")!), collection: roleQueue(productRoles.find(r => r.role === "product-collect")!) },
      initialOcr: options.initial ? registrations : [], ocrWaitMs: options.waitMs ?? 10000 }], workflowExecutionTimeout: "1 minute" });
  return { handle, manifest, registrations };
}
it("streaming OCR dispatches vision immediately, duplicate signals do not re-execute, final join waits without occupying a keyword slot", async () => {
  const keywords = await launch("keyword-stream", "keywords"), vision = await launch("vision-stream"), before = (await executions()).length;
  try {
    const a = await input(), b = await input(a.input.selection.observation), p = await product([a, b]);
    await p.handle.signal("productOcrReady", p.registrations[0]);
    await p.handle.signal("productOcrReady", p.registrations[0]);
    await vi.waitFor(async () => expect(await new PostgresVisionRegistry(db.pool).read(`${p.manifest.operationId}-image-0`)).not.toBeNull(), { timeout: 10000 });
    await vi.waitFor(async () => expect(await p.handle.query("productImageProgress")).toMatchObject({ received: 1, finished: 1, expected: 2 }));
    expect(await executions()).toHaveLength(before + 1);
    // Another product can finish while this Workflow is waiting for its second OCR receipt.
    const other = await product([await input(undefined, "marketing only")], { initial: true });
    expect(await other.handle.result()).toMatchObject({ status: "review", codes: expect.arrayContaining(["SCREEN.NO_LABEL_EVIDENCE"]) });
    expect(await executions()).toHaveLength(before + 1);
    await p.handle.signal("productOcrReady", p.registrations[1]);
    const outcome = await p.handle.result() as { status: string; evidenceKey: string };
    expect(outcome.status).toBe("collected"); expect(await executions()).toHaveLength(before + 2);
    const saved = JSON.parse(objects.get(pathFor(outcome.evidenceKey))!.toString());
    expect(saved.result.provenance).toHaveLength(2); expect(saved.result.ingredients).toHaveLength(1);
    const registry = new PostgresCollectedProducts(db.pool), collected = await registry.read(p.manifest.operationId);
    expect(collected!.formula.columns.flatMap(c => c.nutrients).length).toBeGreaterThan(0);
    expect(collected!.observation).toEqual(p.manifest.observation);
    expect(collected).not.toHaveProperty("companyId");
    const beforeRows = await db.pool.query("SELECT operation_id FROM collected_product");
    await registry.append(collected!); // jsonb round-trip and idempotent INSERT preserve the same snapshot.
    expect(collectedHash(await registry.read(p.manifest.operationId))).toBe(collectedHash(collected));
    expect((await db.pool.query("SELECT operation_id FROM collected_product")).rows).toEqual(beforeRows.rows);
    expect(await registry.read(other.manifest.operationId)).toBeNull();
    await expect(db.pool.query("UPDATE collected_product SET record_hash=record_hash WHERE operation_id=$1", [p.manifest.operationId])).rejects.toThrow("cannot be modified or deleted");
    await expect(db.pool.query("DELETE FROM collected_product WHERE operation_id=$1", [p.manifest.operationId])).rejects.toThrow("cannot be modified or deleted");
  } finally { await stop(keywords); await stop(vision); }
});
it("OCR failure and missing receipt enter classified product Review without any vision fallback", async () => {
  const before = (await executions()).length, a = await input(), failed = await product([a]);
  await failed.handle.signal("productOcrFailed", { imageId: a.input.selection.image.artifactId, code: "OCR.EXECUTION_UNKNOWN", reviewId: "upstream-review" });
  expect(await failed.handle.result()).toMatchObject({ status: "review", codes: expect.arrayContaining(["OCR.EXECUTION_UNKNOWN"]) });
  const timeout = await product([await input()], { waitMs: 1000 });
  expect(await timeout.handle.result()).toMatchObject({ status: "review", codes: expect.arrayContaining(["SCREEN.OCR_NOT_READY"]) });
  expect(await executions()).toHaveLength(before);
});
it("foreign product receipt is rejected before keyword/vision execution", async () => {
  const before = (await executions()).length, p = await product([await input()]);
  const other = await input(), registration = await new PostgresResultRegistry(db.pool).read(other.input.selection.ocrOperationId);
  await p.handle.signal("productOcrReady", registration);
  expect(await p.handle.result()).toMatchObject({ status: "review", codes: expect.arrayContaining(["PRODUCT.IDENTITY_CONFLICT"]) });
  expect(await executions()).toHaveLength(before);
});
it("empty-cache collector replacement verifies a saved collection without new model/PUT, and rejects a second operation for the same observation", async () => {
  const row = (await db.pool.query("SELECT operation_id,record_hash FROM collected_product WHERE record->>'codec'='collected-product/1' LIMIT 1")).rows[0];
  expect(row).toBeDefined();
  const evidenceKey = `v3/products/${row.operation_id}/assembly.json`, saved = JSON.parse(objects.get(pathFor(evidenceKey))!.toString());
  await stop(collectorChild);
  collectorChild = await launchProduct("collector-replacement", productRoles.find(r => r.role === "product-collect")!);
  const beforeCalls = (await executions()).length, beforeWrites = writes;
  const handle = await temporal.client.workflow.start("BusinessCollectProbe", { taskQueue: "business-vision-fixture-workflow",
    workflowId: `collect-replay-${randomUUID()}`, args: [{ task: { join: saved.input, evidenceKey },
      queue: roleQueue(productRoles.find(r => r.role === "product-collect")!) }], workflowExecutionTimeout: "1 minute" });
  expect(await handle.result()).toMatchObject({ status: "collected", operationId: row.operation_id, recordHash: row.record_hash });
  expect(await executions()).toHaveLength(beforeCalls); expect(writes).toBe(beforeWrites);
  const registry = new PostgresCollectedProducts(db.pool), record = await registry.read(row.operation_id);
  await expect(registry.append({ ...record!, operationId: "conflicting-operation" })).rejects.toThrow("COLLECTION.RESULT_CONFLICT");
  expect(await registry.read("conflicting-operation")).toBeNull();
  expect((await db.pool.query("SELECT operation_id FROM collected_product WHERE record->>'codec'='collected-product/1'")).rows).toHaveLength(1);
});
function automaticInput(marker = "", owner?: Observation): OcrInput {
  const task = ocrFixture().input, bytes = Buffer.concat([png, Buffer.from(marker)]);
  Object.assign(task, ocrProvider.supported);
  if (owner) {
    Object.assign(task, owner);
    Object.assign(task.file, { observationId: owner.observationId, sourceId: owner.sourceId, listingId: owner.listingId, variantId: owner.variantId });
  }
  task.file.sha256 = digest(bytes); task.file.byteSize = bytes.length;
  task.inputFingerprint = fingerprintOcrInput(task, digest); objects.set(pathFor(task.file.objectKey), bytes);
  return task;
}
async function automaticProduct(tasks: OcrInput[], ocrQueue = `v3.ocr.file.v1.${ocrMetadata.compatibility}`) {
  const manifest = { operationId: `auto-${randomUUID()}`, observation: observationIdentity(tasks[0]!),
    imageIds: tasks.map(t => t.file.artifactId), configFingerprint: CodexVisionProvider.describe(codexConfig("input")).configFingerprint };
  const handle = await temporal.client.workflow.start("ProductImageWorkflow", { taskQueue: roleQueue(productWorkflowRole),
    workflowId: manifest.operationId, args: [{ manifest, ocrTasks: tasks,
      queues: { ocr: ocrQueue, receipts: roleQueue(productRoles.find(r => r.role === "ocr-receipt")!), keywords: keywordQueue, vision: queue,
        assembly: roleQueue(productRoles.find(r => r.role === "product-images-assembly")!), collection: roleQueue(productRoles.find(r => r.role === "product-collect")!) } }],
    workflowExecutionTimeout: "1 minute" });
  return { manifest, handle };
}
it("owned OCR releases its Worker before receipt handling; replacement Workflow resumes native completions without re-OCR", async () => {
  const ocr = await launch("auto-ocr", "ocr"), keywords = await launch("auto-keywords", "keywords"), vision = await launch("auto-vision");
  let receipt: ChildProcess | undefined;
  const beforeOcr = ocrCalls, beforeVision = (await executions()).length;
  try {
    const first = automaticInput(), second = automaticInput("", observationIdentity(first));
    const a = await automaticProduct([first, second]), noLabelInput = automaticInput("NO_LABEL"), b = await automaticProduct([noLabelInput]);
    // Owned mode ignores unsolicited external receipts; they cannot finish or corrupt its OCR operations.
    await a.handle.signal("productOcrFailed", { imageId: first.file.artifactId, code: "OCR.UNCLASSIFIED", reviewId: "foreign-review" });
    await vi.waitFor(async () => {
      for (const task of [first, second, noLabelInput]) expect(await new PostgresResultRegistry(db.pool).read(task.operationId)).not.toBeNull();
      for (const p of [a, b]) expect((await p.handle.fetchHistory()).events?.filter(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "resolveOcrReceipt")).toHaveLength(p.manifest.imageIds.length);
    }, { timeout: 15000 });
    expect(ocrCalls).toBe(beforeOcr + 3); expect(await executions()).toHaveLength(beforeVision);
    // No receipt Worker exists yet. OCR nevertheless finished three files and can be stopped cleanly.
    await stop(ocr); await stop(productWorkflowChild);
    productWorkflowChild = await launchProduct("workflow-replacement-after-ocr", productWorkflowRole);
    receipt = await launchProduct("auto-receipts", productRoles.find(r => r.role === "ocr-receipt")!);
    expect(await a.handle.result()).toMatchObject({ status: "collected" });
    expect(await b.handle.result()).toMatchObject({ status: "review", codes: expect.arrayContaining(["SCREEN.NO_LABEL_EVIDENCE"]) });
    expect(ocrCalls).toBe(beforeOcr + 3); expect(await executions()).toHaveLength(beforeVision + 2);
    const history = await a.handle.fetchHistory();
    expect(history.events?.filter(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "ocrFile")).toHaveLength(2);
    expect(history.events?.filter(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "resolveOcrReceipt")).toHaveLength(2);
    await writeFile(join(root, "automatic-ocr-history.json"), JSON.stringify(history));
  } finally { await stop(ocr); await stop(keywords); await stop(vision); if (receipt) await stop(receipt); }
});
it("owned OCR failure is verified and forwarded as Review, without keyword/vision fallback or extra OCR", async () => {
  const ocr = await launch("auto-ocr-failure", "ocr"), receipts = await launchProduct("auto-receipt-failure", productRoles.find(r => r.role === "ocr-receipt")!);
  const before = ocrCalls, vision = (await executions()).length;
  try {
    const task = automaticInput("FAIL_OCR"), p = await automaticProduct([task]);
    const result = await p.handle.result() as { status: string; codes: string[] };
    expect(result.status).toBe("review"); expect(result.codes.some(c => c.startsWith("OCR."))).toBe(true);
    expect(ocrCalls).toBe(before + 1); expect(await executions()).toHaveLength(vision);
    const history = await p.handle.fetchHistory();
    expect(history.events?.some(e => ["screenImageKeywords", "interpretImage", "collectProduct"].includes(e.activityTaskScheduledEventAttributes?.activityType?.name ?? ""))).toBe(false);
    expect((await db.pool.query("SELECT review_id FROM review_record WHERE record->'failure'->>'operationId'=$1", [task.operationId])).rows).toHaveLength(1);
  } finally { await stop(ocr); await stop(receipts); }
});
it("a failed OCR Activity with durable registered evidence reconciles through the separate receipt Worker", async () => {
  const task = automaticInput(), ocr = await launch("lost-ack-ocr", "ocr");
  const probe = await temporal.client.workflow.start("BusinessOcrProbe", { taskQueue: "business-vision-fixture-workflow",
    workflowId: `ocr-seed-${randomUUID()}`, args: [{ task, queue: `v3.ocr.file.v1.${ocrMetadata.compatibility}` }], workflowExecutionTimeout: "1 minute" });
  await probe.result(); await stop(ocr);
  // Explicit fault injection: evidence already committed but the scheduled OCR Activity returns a failure.
  const faultQueue = `fault-${randomUUID()}`; let activityCalls = 0;
  const fault = await Worker.create({ connection: temporal.nativeConnection, taskQueue: faultQueue,
    activities: { ocrFile: async () => { activityCalls++; throw ApplicationFailure.nonRetryable("Synthetic lost completion response", "TEST.LOST_RESPONSE"); } } });
  const faultRunning = fault.run(), before = ocrCalls;
  const receipt = await launchProduct("lost-ack-receipt", productRoles.find(r => r.role === "ocr-receipt")!);
  const keywords = await launch("lost-ack-keywords", "keywords"), vision = await launch("lost-ack-vision");
  try {
    const p = await automaticProduct([task], faultQueue);
    expect(await p.handle.result()).toMatchObject({ status: "collected" });
    expect(ocrCalls).toBe(before); expect(activityCalls).toBe(1);
    const beforeVision = (await executions()).length, missing = await automaticProduct([automaticInput()], faultQueue);
    expect(await missing.handle.result()).toMatchObject({ status: "review", codes: expect.arrayContaining(["RECEIPT.OCR_UNCONFIRMED"]) });
    expect(ocrCalls).toBe(before); expect(activityCalls).toBe(2); expect(await executions()).toHaveLength(beforeVision);
  } finally { fault.shutdown(); await faultRunning; await stop(receipt); await stop(keywords); await stop(vision); }
});
function filePlan(owner: Observation = observationIdentity(ocrFixture().input)): FileOcrPlan {
  const operationId = `download-${randomUUID()}`, unsigned = { ...owner, operationId, module: "file.acquire" as const,
    implementationVersion: "1", policyVersion: "1", configFingerprint: FILE_CONFIG_FINGERPRINT,
    resourceId: `resource-${randomUUID()}`, binding: { sessionId: "private-static-session", egressId: "direct/1" },
    expectedSha256: digest(sourcePng), inputFingerprint: "0".repeat(64) };
  const acquire = { ...unsigned, inputFingerprint: digest(acquisitionFingerprintMaterial(unsigned)) };
  return { imageId: acquiredImageId(operationId), acquire, ocrOperationId: `ocr-${randomUUID()}`, ocr: ocrProvider.supported };
}
async function fileProduct(plans: FileOcrPlan[]) {
  const manifest = { operationId: `file-product-${randomUUID()}`, observation: observationIdentity(plans[0]!.acquire),
    imageIds: plans.map(p => p.imageId), configFingerprint: CodexVisionProvider.describe(codexConfig("file-product")).configFingerprint };
  const handle = await temporal.client.workflow.start("ProductImageWorkflow", { taskQueue: roleQueue(productWorkflowRole), workflowId: manifest.operationId,
    args: [{ manifest, fileTasks: plans, queues: { acquire: roleQueue(acquisitionRoles.find(r => r.role === "file-acquire")!),
      prepare: roleQueue(acquisitionRoles.find(r => r.role === "image-ocr-input")!), ocr: `v3.ocr.file.v1.${ocrMetadata.compatibility}`,
      receipts: roleQueue(productRoles.find(r => r.role === "ocr-receipt")!), keywords: keywordQueue, vision: queue,
      assembly: roleQueue(productRoles.find(r => r.role === "product-images-assembly")!), collection: roleQueue(productRoles.find(r => r.role === "product-collect")!) } }],
    workflowExecutionTimeout: "1 minute" });
  return { manifest, handle };
}
it("source HTTPS downloads stream into independent image preparation/OCR, and an empty-cache acquisition replacement does not redownload", async () => {
  const first = filePlan(), second = filePlan(observationIdentity(first.acquire)), plans = [first, second];
  for (const p of plans) sourceFiles.set(`/${p.acquire.resourceId}`, sourcePng);
  const blocked = `/${second.acquire.resourceId}`; blockedSources.add(blocked);
  let downloader = await launchAcquisition("file-download", acquisitionRoles.find(r => r.role === "file-acquire")!, plans);
  const preparation = await launchAcquisition("file-prepare", acquisitionRoles.find(r => r.role === "image-ocr-input")!);
  const ocr = await launch("file-ocr", "ocr"), receipt = await launchProduct("file-receipt", productRoles.find(r => r.role === "ocr-receipt")!);
  const keywords = await launch("file-keywords", "keywords"), vision = await launch("file-vision");
  const beforeSource = sourceCalls, beforeOcr = ocrCalls, beforeModel = (await executions()).length;
  try {
    const p = await fileProduct(plans);
    await vi.waitFor(async () => expect(await new PostgresVisionRegistry(db.pool).read(`${p.manifest.operationId}-image-0`)).not.toBeNull(), { timeout: 15000 });
    expect(ocrCalls).toBe(beforeOcr + 1); expect(await executions()).toHaveLength(beforeModel + 1);
    expect(await new PostgresResultRegistry(db.pool).read(second.ocrOperationId)).toBeNull();
    expect(sourceReleases.has(blocked)).toBe(true); blockedSources.delete(blocked); sourceReleases.get(blocked)!(); sourceReleases.delete(blocked);
    expect(await p.handle.result()).toMatchObject({ status: "collected" });
    expect(sourceCalls).toBe(beforeSource + 2); expect(ocrCalls).toBe(beforeOcr + 2); expect(await executions()).toHaveLength(beforeModel + 2);
    const history = JSON.stringify(await p.handle.fetchHistory());
    // Protobuf JSON serializes payload bytes as base64; inspect decoded payloads, not only the history envelope.
    const decoded = JSON.stringify(JSON.parse(history), (_key, value) => value && typeof value === "object" && value.metadata && typeof value.data === "string"
      ? { ...value, data: Buffer.from(value.data, "base64").toString("utf8") } : value);
    expect(decoded).toContain(first.acquire.resourceId);
    expect(decoded).not.toContain("private-source-canary"); expect(decoded).not.toContain("https://files.example");
    await writeFile(join(root, "file-product-history.json"), history);
    await stop(downloader);
    downloader = await launchAcquisition("file-download-replacement", acquisitionRoles.find(r => r.role === "file-acquire")!); // no source URLs on this node
    const writesBefore = writes;
    const repeated = await temporal.client.workflow.start("BusinessAcquireProbe", { taskQueue: "business-vision-fixture-workflow",
      workflowId: `download-replay-${randomUUID()}`, args: [{ task: first.acquire, queue: roleQueue(acquisitionRoles.find(r => r.role === "file-acquire")!) }], workflowExecutionTimeout: "1 minute" });
    expect(await repeated.result()).toMatchObject({ status: "durable", file: { sha256: digest(sourcePng) } });
    expect(sourceCalls).toBe(beforeSource + 2); expect(writes).toBe(writesBefore); expect(ocrCalls).toBe(beforeOcr + 2);
  } finally {
    blockedSources.delete(blocked); sourceReleases.get(blocked)?.(); sourceReleases.delete(blocked);
    await Promise.all([downloader, preparation, ocr, receipt, keywords, vision].map(stop));
  }
});
it("source failure is classified before OCR and repeated delivery never refetches the URL", async () => {
  const plan = filePlan(), downloader = await launchAcquisition("file-failure", acquisitionRoles.find(r => r.role === "file-acquire")!, [plan]);
  const preparation = await launchAcquisition("prepare-failure", acquisitionRoles.find(r => r.role === "image-ocr-input")!);
  const before = sourceCalls, beforeOcr = ocrCalls, beforeModel = (await executions()).length;
  try {
    const p = await fileProduct([plan]);
    expect(await p.handle.result()).toMatchObject({ status: "review", codes: expect.arrayContaining(["SOURCE.HTTP_STATUS"]) });
    expect(sourceCalls).toBe(before + 1); expect(ocrCalls).toBe(beforeOcr); expect(await executions()).toHaveLength(beforeModel);
    const repeated = await temporal.client.workflow.start("BusinessAcquireProbe", { taskQueue: "business-vision-fixture-workflow",
      workflowId: `download-failure-${randomUUID()}`, args: [{ task: plan.acquire, queue: roleQueue(acquisitionRoles.find(r => r.role === "file-acquire")!) }], workflowExecutionTimeout: "1 minute" });
    expect(await repeated.result()).toMatchObject({ status: "review", code: "ACQUIRE.EXECUTION_UNKNOWN" });
    expect(sourceCalls).toBe(before + 1);
  } finally { await stop(downloader); await stop(preparation); }
});

async function pdfConfig(host: string, installed = true) {
  const old = JSON.parse(await readFile(await acquisitionConfig(host, []), "utf8")); delete old.sources;
  const path = join(root, `${host}-pdf.json`);
  await writeFile(path, JSON.stringify({ ...old, r2: { ...old.r2, timeoutMs: 20000 }, pythonExecutable: installed ? resolve("../../packages/v3-pdf/.venv/bin/python") : join(root, "not-installed"),
    workRoot: join(root, host, "attempts") }), { mode: 0o600 });
  return path;
}
async function launchPdf(host: string, role: ProductRole, installed = true) {
  const runtime = join(root, `${host}-worker.json`);
  await writeFile(runtime, JSON.stringify({ role: role.role, capability: role.capability, compatibility: role.compatibility, contractVersion: 1,
    expectedBuildId: role.buildId, hostId: host, namespace: "default", address: temporal.address, transport: { mode: "local" },
    concurrency: 2, shutdownGraceMs: 2000, shutdownForceMs: 5000 }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", resolve("integration/fixtures/acquisition-loopback.mjs"), resolve("dist/pdf-worker.js")], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, "cert.pem"), V3_TEST_S3_PORT: String(port), V3_PDF_LIVE_ENABLED: "true",
      V3_PDF_CONFIG: await pdfConfig(host, installed), V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: runtime }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child); let logs = "";
  child.stdout!.on("data", b => { logs = (logs + String(b)).slice(-20000); }); child.stderr!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  await vi.waitFor(() => { if (child.exitCode !== null) throw Error(logs); expect(logs).toContain('"event":"WORKER_RUNNING"'); }, { timeout: 15000 });
  return child;
}
async function pdfRoles(): Promise<ProductRole[]> {
  return JSON.parse((await exec(process.execPath, [resolve("dist/pdf-worker.js"), "--list"], { env: { ...process.env,
    V3_PDF_LIVE_ENABLED: "true", V3_PDF_CONFIG: await pdfConfig("pdf-metadata") } })).stdout);
}
async function submitPdf(task: PdfInput, role: ProductRole, activity = task.module === "pdf.inspect" ? "inspectPdf" : task.module === "pdf.text" ? "extractPdfPageText" : "renderPdfPage") {
  return temporal.client.workflow.start("BusinessPdfProbe", { taskQueue: "business-vision-fixture-workflow", workflowId: `pdf-${randomUUID()}`,
    args: [{ task, queue: roleQueue(role), activity }], workflowExecutionTimeout: "1 minute" });
}
it("three independent PDF roles publish real Python outputs; replacement without Python reuses shared evidence", async () => {
  const roles = await pdfRoles(), bytes = nutritionPdf(), tasks = (["pdf.inspect", "pdf.text", "pdf.render"] as const).map(module => pdfInputFor(bytes, module, `pdf-${randomUUID()}`));
  objects.set(pathFor(tasks[0]!.pdf.objectKey), bytes);
  const workers = await Promise.all(roles.filter(r => ["pdf.inspect","pdf.text","pdf.render"].includes(r.capability)).map(role => launchPdf(role.role, role)));
  const beforeOcr = ocrCalls, beforeModels = (await executions()).length;
  try {
    const outputs = await Promise.all(tasks.map(async task => {
      const handle = await submitPdf(task, roles.find(r => r.capability === task.module)!);
      return PdfActivityOutcomeSchema.parse(await handle.result());
    }));
    expect(outputs.every(o => o.status === "durable")).toBe(true);
    const pids = new Set<number>();
    for (const out of outputs) {
      if (out.status !== "durable") throw Error();
      const completion = JSON.parse(objects.get(pathFor(out.evidenceKey))!.toString()); pids.add(completion.manifest.process.pid);
      const output = objects.get(pathFor(out.artifact.objectKey))!;
      if (out.artifact.kind === "pdf-page") {
        expect(out.artifact).toMatchObject({ parentArtifactId: tasks[0]!.pdf.artifactId, pageIndex: 0 });
        await writeFile(join(root, "pdf-worker-render.png"), output);
      } else {
        const data = JSON.parse(output.toString());
        if (data.kind === "text") expect(data.text).toContain("Vitamin C: 100 mg"); else expect(data.pageCount).toBe(1);
      }
    }
    expect(pids.size).toBe(3); expect(ocrCalls).toBe(beforeOcr); expect(await executions()).toHaveLength(beforeModels);
    await Promise.all(workers.map(stop));
    const role = roles.find(r => r.capability === "pdf.render")!, replacement = await launchPdf("pdf-replacement", role, false);
    try {
      const before = writes, result = await (await submitPdf(tasks[2]!, role)).result();
      expect(result).toEqual(outputs[2]); expect(writes).toBe(before);
      expect(await readdir(join(root, "pdf-replacement", "attempts"))).toHaveLength(0);
    } finally { await stop(replacement); }
  } finally { await Promise.all(workers.map(stop)); }
});
it("PDF page failures and failed shared completion remain passive without another Python attempt", async () => {
  const role = (await pdfRoles()).find(r => r.capability === "pdf.render")!, worker = await launchPdf("pdf-errors", role);
  const source = nutritionPdf(), beforeOcr = ocrCalls, beforeModels = (await executions()).length;
  objects.set(pathFor(pdfInputFor(source, "pdf.inspect").pdf.objectKey), source);
  try {
    const wrong = pdfInputFor(source, "pdf.text", `wrong-role-${randomUUID()}`);
    await expect((await submitPdf(wrong, role, "renderPdfPage")).result()).rejects.toThrow();
    expect(await readdir(join(root, "pdf-errors", "attempts"))).toHaveLength(0);
    const bad = pdfInputFor(source, "pdf.render", `bad-page-${randomUUID()}`, 10);
    expect(await (await submitPdf(bad, role)).result()).toMatchObject({ status: "review", code: "PDF.PAGE_RANGE" });
    const good = pdfInputFor(source, "pdf.render", `lost-pdf-${randomUUID()}`); denyResults = true;
    expect(await (await submitPdf(good, role)).result()).toMatchObject({ status: "review" }); denyResults = false;
    const attempts = await readdir(join(root, "pdf-errors", "attempts")); expect(attempts).toHaveLength(2);
    for (const task of [bad, good]) expect(await (await submitPdf(task, role)).result()).toMatchObject({ status: "review", code: "PDF.EXECUTION_UNKNOWN" });
    expect(await readdir(join(root, "pdf-errors", "attempts"))).toEqual(attempts);
    expect(ocrCalls).toBe(beforeOcr); expect(await executions()).toHaveLength(beforeModels);
  } finally { denyResults = false; await stop(worker); }
});

function pdfProductInput(pageCount = 2) {
  const bytes = nutritionPdf(pageCount), id = `pdf-product-${randomUUID()}`, inspection = pdfInputFor(bytes, "pdf.inspect", `inspect-${randomUUID()}`);
  // A unique observation per product, and the source reference follows it.
  inspection.observationId = id; inspection.listingId = id; inspection.pdf = { ...inspection.pdf, observationId: id, listingId: id, artifactId: `source-${randomUUID()}`, objectKey: `pdf-products/${id}/source.pdf` };
  inspection.inputFingerprint = fingerprintPdfInput(inspection);
  objects.set(pathFor(inspection.pdf.objectKey), bytes);
  return { operationId: id, inspection, scale: 1, ocr: { ...ocrProvider.supported }, configFingerprint: CodexVisionProvider.describe(codexConfig("pdf-product-profile")).configFingerprint };
}
async function startPdfProduct(plan: ReturnType<typeof pdfProductInput>, roles: ProductRole[], renderQueue?: string) {
  return temporal.client.workflow.start("ProductPdfWorkflow", { taskQueue: roleQueue(productWorkflowRole), workflowId: plan.operationId,
    args: [{ plan, queues: { inspection: roleQueue(roles.find(r => r.capability === "pdf.inspect")!), pages: roleQueue(roles.find(r => r.capability === "pdf.pages.prepare")!),
      pdfRender: renderQueue ?? roleQueue(roles.find(r => r.capability === "pdf.render")!), pdfPrepare: roleQueue(roles.find(r => r.capability === "pdf.ocr.prepare")!),
      ocr: `v3.ocr.file.v1.${ocrMetadata.compatibility}`, receipts: roleQueue(productRoles.find(r => r.role === "ocr-receipt")!), keywords: keywordQueue, vision: queue,
      assembly: roleQueue(productRoles.find(r => r.role === "product-images-assembly")!), collection: roleQueue(productRoles.find(r => r.role === "product-collect")!) } }], workflowExecutionTimeout: "1 minute" });
}
it("PDF pages stream through OCR and vision while a sibling render handoff waits, then collect one product", async () => {
  const roles = await pdfRoles(), plan = pdfProductInput(), workers = await Promise.all(roles.filter(r => r.capability !== "pdf.text").map(r => launchPdf(`chain-${r.role}`, r)));
  const ocr = await launch("pdf-chain-ocr", "ocr"), receipt = await launchProduct("pdf-chain-receipt", productRoles.find(r => r.role === "ocr-receipt")!),
    keywords = await launch("pdf-chain-keywords", "keywords"), vision = await launch("pdf-chain-vision");
  const beforeOcr = ocrCalls, beforeModels = (await executions()).length;
  blockedPdfFragment = `${plan.operationId}-render-1`;
  try {
    const handle = await startPdfProduct(plan, roles);
    await vi.waitFor(async () => expect(await new PostgresVisionRegistry(db.pool).read(`${plan.operationId}-image-0`)).not.toBeNull(), { timeout: 15000 });
    expect(pdfReadReleases.size).toBeGreaterThan(0); expect(ocrCalls).toBe(beforeOcr + 1); expect(await executions()).toHaveLength(beforeModels + 1);
    expect(await new PostgresResultRegistry(db.pool).read(`${plan.operationId}-ocr-1`)).toBeNull();
    blockedPdfFragment = null; for (const release of pdfReadReleases) release(); pdfReadReleases.clear();
    expect(await handle.result()).toMatchObject({ status: "collected", operationId: plan.operationId });
    expect(ocrCalls).toBe(beforeOcr + 2); expect(await executions()).toHaveLength(beforeModels + 2);
    const history = JSON.stringify(await handle.fetchHistory()); await writeFile(join(root, "pdf-product-history.json"), history);
    const saved = await db.pool.query("SELECT record FROM collected_product WHERE operation_id=$1", [plan.operationId]);
    expect(saved.rows[0].record.provenance.map((p: { image: { pageIndex: number } }) => p.image.pageIndex).sort()).toEqual([0,1]);
  } finally {
    blockedPdfFragment = null; for (const release of pdfReadReleases) release(); pdfReadReleases.clear();
    await Promise.all([...workers, ocr, receipt, keywords, vision].map(stop));
  }
});
it("PDF over the product page limit enters Review before any render/OCR/model dispatch", async () => {
  const roles = await pdfRoles(), workers = await Promise.all(roles.filter(r => ["pdf.inspect","pdf.pages.prepare"].includes(r.capability)).map(r => launchPdf(`limit-${r.role}`, r)));
  const beforeOcr = ocrCalls, beforeModels = (await executions()).length;
  try {
    const handle = await startPdfProduct(pdfProductInput(101), roles);
    expect(await handle.result()).toMatchObject({ status: "review", codes: ["PDF.PRODUCT_PAGE_LIMIT"] });
    expect(ocrCalls).toBe(beforeOcr); expect(await executions()).toHaveLength(beforeModels);
    const history = await handle.fetchHistory();
    expect(history.events?.filter(e => e.activityTaskScheduledEventAttributes).map(e => e.activityTaskScheduledEventAttributes!.activityType!.name)).toEqual(["inspectPdf","preparePdfPages"]);
  } finally { await Promise.all(workers.map(stop)); }
});
it("lost PDF render responses reconcile durable evidence only; missing evidence does not trigger OCR or re-render", async () => {
  const roles = await pdfRoles(), workers = await Promise.all(roles.filter(r => ["pdf.inspect","pdf.pages.prepare","pdf.ocr.prepare"].includes(r.capability)).map(r => launchPdf(`lost-${r.role}`, r)));
  const renderRole = roles.find(r => r.capability === "pdf.render")!, renderer = await launchPdf("lost-render-seed", renderRole);
  const ocr = await launch("lost-pdf-ocr", "ocr"), receipt = await launchProduct("lost-pdf-receipt", productRoles.find(r => r.role === "ocr-receipt")!),
    keywords = await launch("lost-pdf-keywords", "keywords"), vision = await launch("lost-pdf-vision");
  const faultQueue = `pdf-fault-${randomUUID()}`;
  const fault = await Worker.create({ connection: temporal.nativeConnection, taskQueue: faultQueue,
    activities: { renderPdfPage: async () => { throw ApplicationFailure.nonRetryable("Synthetic lost render response", "TEST.LOST_RESPONSE"); } } });
  const runningFault = fault.run(), beforeOcr = ocrCalls, beforeModels = (await executions()).length;
  try {
    const plan = pdfProductInput(1), render: PdfInput = { ...plan.inspection, module: "pdf.render", operationId: `${plan.operationId}-render-0`, pageIndex: 0, scale: plan.scale };
    render.inputFingerprint = fingerprintPdfInput(render);
    expect(await (await submitPdf(render, renderRole)).result()).toMatchObject({ status: "durable" });
    await stop(renderer);
    expect(await (await startPdfProduct(plan, roles, faultQueue)).result()).toMatchObject({ status: "collected" });
    expect(ocrCalls).toBe(beforeOcr + 1); expect(await executions()).toHaveLength(beforeModels + 1);
    expect(await readdir(join(root, "lost-render-seed", "attempts"))).toHaveLength(1);
    const missing = await startPdfProduct(pdfProductInput(1), roles, faultQueue);
    expect(await missing.result()).toMatchObject({ status: "review", codes: expect.arrayContaining(["PDF.NOT_DURABLE"]) });
    expect(ocrCalls).toBe(beforeOcr + 1); expect(await executions()).toHaveLength(beforeModels + 1);
  } finally {
    fault.shutdown(); await runningFault;
    await Promise.all([...workers, renderer, ocr, receipt, keywords, vision].map(stop));
  }
});
it("PDF pages without OCR keywords skip visual interpretation and remain passive Review", async () => {
  const roles = await pdfRoles(), workers = await Promise.all(roles.filter(r => r.capability !== "pdf.text").map(r => launchPdf(`unmatched-${r.role}`, r)));
  const ocr = await launch("unmatched-pdf-ocr", "ocr"), receipt = await launchProduct("unmatched-pdf-receipt", productRoles.find(r => r.role === "ocr-receipt")!), keywords = await launch("unmatched-pdf-keywords", "keywords");
  const beforeOcr = ocrCalls, beforeModels = (await executions()).length; ocrForceNoLabel = true;
  try {
    const handle = await startPdfProduct(pdfProductInput(1), roles);
    expect(await handle.result()).toMatchObject({ status: "review" });
    expect(ocrCalls).toBe(beforeOcr + 1); expect(await executions()).toHaveLength(beforeModels);
    const history = await handle.fetchHistory();
    const activities = history.events?.filter(e => e.activityTaskScheduledEventAttributes).map(e => e.activityTaskScheduledEventAttributes!.activityType!.name);
    expect(activities).toContain("screenImageKeywords"); expect(activities).not.toContain("interpretImage"); expect(activities).not.toContain("collectProduct");
  } finally { ocrForceNoLabel = false; await Promise.all([...workers, ocr, receipt, keywords].map(stop)); }
});
