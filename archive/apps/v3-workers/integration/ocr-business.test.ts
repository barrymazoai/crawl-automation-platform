import { createServer as httpServer, type Server } from "node:http";
import { createServer as httpsServer } from "node:https";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { MultipartOcr } from "@crawl-automation/v3-ocr";
import { fingerprintOcrInput, OcrOutputSchema, type OcrInput, type OcrActivityOutcome } from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/v3-artifacts";
import { PostgresResultRegistry, verifyCompletion } from "@crawl-automation/v3-results";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { startTestDatabase } from "../../v3-api/integration/postgres.js";
import { fixture } from "../../../packages/v3-results/src/testing.fixture.js";

const exec = promisify(execFile), entry = resolve("dist/ocr-worker.js");
const fakeHost = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com";
const bucket = "synthetic-only", prefix = `business-ocr/${randomUUID()}`;
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOuoAAAAASUVORK5CYII=", "base64");
const reply = { text: "Synthetic OCR result", lines: [{ text: "Synthetic OCR result", score: 0.98, polygon: [[0, 0], [100, 0], [100, 30], [0, 30]] }], request_id: "synthetic-service" };
const objects = new Map<string, Buffer>(), calls: { method: string; key: string }[] = [];
const children: ChildProcess[] = [];
let root: string, endpoint: string, s3Port: number, mode = "ok", ocrCalls = 0, denyWrites = false, denyResults = false;
let db: Awaited<ReturnType<typeof startTestDatabase>>, temporal: TestWorkflowEnvironment;
let ocr: Server, s3: ReturnType<typeof httpsServer>, workflow: Worker, running: Promise<void>;
let metadata: { buildId: string; compatibility: string }, queue: string, provider: MultipartOcr;
let resultUrl: string, reviewUrl: string;
const pathFor = (key: string) => `/${bucket}/${prefix}/${key}`;
async function listen(server: Server): Promise<number> {
  await new Promise<void>((r, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", r); });
  const address = server.address(); if (!address || typeof address === "string") throw Error(); return address.port;
}
async function config(host: string) {
  const path = join(root, `${host}-ocr.json`);
  await writeFile(path, JSON.stringify({
    provider: { endpoint, allowLoopbackHttp: true, minScore: 0.3, provider: "synthetic-http/1" },
    storageId: "isolated-s3/1", cacheRoot: join(root, host, "cache"), journalRoot: join(root, host, "journal"),
    r2: { endpoint: `https://${fakeHost}`, bucket, prefix, timeoutMs: 2000 },
    r2Credentials: { accessKeyId: "synthetic-key", secretAccessKey: "synthetic-secret" },
    resultDatabase: { connectionString: resultUrl, tls: false }, reviewDatabase: { connectionString: reviewUrl, tls: false },
  }), { mode: 0o600 }); return path;
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "v3-ocr-business-"));
  db = await startTestDatabase({ tcp: true });
  // Dedicated append-only identities in this newly initialized test cluster, never superuser workers.
  for (const [role, table] of [["ocr_result", "processing_result"], ["ocr_review", "review_record"]]) {
    const password = randomUUID();
    await db.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await db.pool.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT ON ${table} TO ${role}`);
    const url = new URL(db.databaseUrl!); url.username = role!; url.password = password;
    if (role === "ocr_result") resultUrl = url.href; else reviewUrl = url.href;
  }
  // Ephemeral test certificate; no machine trust-store change and no TLS verification bypass.
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${fakeHost}`,
    "-addext", `subjectAltName=DNS:${fakeHost}`, "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")]);
  s3 = httpsServer({ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) }, (req, res) => {
    const key = new URL(req.url!, "https://fixture").pathname;
    calls.push({ method: req.method!, key });
    const fail = (status: number, code: string) => { res.writeHead(status, { "Content-Type": "application/xml" }); res.end(`<Error><Code>${code}</Code></Error>`); };
    if (!key.startsWith(`/${bucket}/${prefix}/`) || !req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) return fail(403, "AccessDenied");
    if (req.method === "GET") {
      const data = objects.get(key); if (!data) return fail(404, "NoSuchKey");
      res.writeHead(200, { "Content-Length": data.length }); res.end(data); return;
    }
    if (req.method !== "PUT" || req.headers["if-none-match"] !== "*") return fail(403, "AccessDenied");
    const chunks: Buffer[] = []; req.on("data", b => chunks.push(b)); req.on("end", () => {
      if (denyWrites || (denyResults && key.endsWith("/result.json"))) return fail(503, "ServiceUnavailable");
      if (objects.has(key)) return fail(412, "PreconditionFailed");
      objects.set(key, Buffer.concat(chunks)); res.writeHead(200, { ETag: '"fixture"' }); res.end();
    });
  });
  s3Port = await listen(s3);
  ocr = httpServer((req, res) => { ocrCalls++; req.resume(); req.on("end", () => {
    if (req.url !== "/ocr?min_score=0.3") { res.writeHead(400); res.end(); return; }
    res.writeHead(mode === "fail" ? 500 : 200, { "Content-Type": "application/json" }); res.end(JSON.stringify(reply));
  }); });
  endpoint = `http://127.0.0.1:${await listen(ocr)}/ocr`;
  provider = new MultipartOcr({ endpoint, allowLoopbackHttp: true, minScore: 0.3, provider: "synthetic-http/1" });
  const settings = await config("metadata");
  metadata = JSON.parse((await exec(process.execPath, [entry, "--list"], { env: { ...process.env, V3_OCR_LIVE_ENABLED: "true", V3_OCR_CONFIG: settings } })).stdout)[0];
  queue = `v3.ocr.file.v1.${metadata.compatibility}`;
  temporal = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false,
    executable: process.env.V3_TEST_TEMPORAL_CLI ? { type: "existing-path", path: process.env.V3_TEST_TEMPORAL_CLI } : { type: "cached-download", version: "v1.8.3" } } });
  workflow = await Worker.create({ connection: temporal.nativeConnection, taskQueue: "business-ocr-fixture-workflow", workflowBundle: { codePath: resolve(".local/test-dist/ocr-workflows.cjs") } });
  running = workflow.run();
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
  if (db) await writeFile(join(root, "database-proof.json"), JSON.stringify({ ocrCalls, calls,
    results: (await db.pool.query("SELECT operation_id,record_hash FROM processing_result")).rows,
    reviews: (await db.pool.query("SELECT review_id,record->'failure' AS failure FROM review_record")).rows }, null, 2));
  await temporal?.teardown(); await db?.close();
  for (const server of [s3, ocr]) if (server) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  console.log(`Business OCR isolated evidence: ${root}; real OCR/R2 requests: 0`);
});
async function launch(host: string) {
  const settings = await config(host), runtime = join(root, `${host}-worker.json`);
  await writeFile(runtime, JSON.stringify({ role: "ocr-file", capability: "ocr.file", contractVersion: 1,
    compatibility: metadata.compatibility, expectedBuildId: metadata.buildId, hostId: host, namespace: "default", address: temporal.address,
    transport: { mode: "local" }, concurrency: 3, shutdownGraceMs: 2000, shutdownForceMs: 5000 }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", resolve("integration/fixtures/s3-loopback.mjs"), entry], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, "cert.pem"), V3_TEST_S3_PORT: String(s3Port),
      V3_OCR_LIVE_ENABLED: "true", V3_OCR_CONFIG: settings, V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: runtime }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child); let logs = "";
  child.stdout!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  child.stderr!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  await vi.waitFor(() => { if (child.exitCode !== null) throw Error(logs); expect(logs).toContain('"event":"WORKER_RUNNING"'); }, { timeout: 15000 });
  return child;
}
function input(): OcrInput {
  const task = fixture().input; Object.assign(task, provider.supported);
  task.file.sha256 = sha256(bytes); task.file.byteSize = bytes.length;
  task.inputFingerprint = fingerprintOcrInput(task, t => sha256(Buffer.from(t)));
  objects.set(pathFor(task.file.objectKey), bytes); return task;
}
const start = (task: OcrInput) => temporal.client.workflow.start("BusinessOcrProbe", { taskQueue: "business-ocr-fixture-workflow",
  workflowId: `business-ocr-${randomUUID()}`, args: [{ task, queue }], workflowExecutionTimeout: "1 minute" });
it("compiled business entry reads remote input, persists v2 to PostgreSQL and survives a fresh-cache replacement", async () => {
  const task = input(), first = await start(task), before = ocrCalls;
  await vi.waitFor(async () => expect((await first.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes)).toBe(true));
  expect(ocrCalls).toBe(before);
  const worker = await launch("business-node-a");
  const outcome = await first.result();
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "registered" });
  expect(ocrCalls - before).toBe(1);
  const registry = new PostgresResultRegistry(db.pool), record = (await registry.read(task.operationId))!;
  const outputBytes = objects.get(pathFor(record.result.objectKey))!;
  expect(OcrOutputSchema.parse(JSON.parse(outputBytes.toString()))).toMatchObject({ resultSchemaVersion: 2, rawResponse: reply });
  verifyCompletion(record, outputBytes, objects.get(pathFor(record.completion.objectKey))!);
  expect(calls.some(c => c.method === "GET" && c.key === pathFor(task.file.objectKey))).toBe(true);
  await stop(worker);
  const next = await launch("business-node-b"), puts = calls.filter(c => c.method === "PUT").length;
  expect(await (await start(task)).result()).toEqual(await first.result());
  expect(ocrCalls - before).toBe(1); expect(calls.filter(c => c.method === "PUT")).toHaveLength(puts);
  await writeFile(join(root, "business-proof.json"), JSON.stringify({ firstPid: worker.pid, replacementPid: next.pid,
    workflowId: first.workflowId, operationId: task.operationId, resultVersion: 2, ocrCalls: 1, freshCacheReadOnlyRecovery: true,
    realPostgres: true, realTemporal: true, simulatedS3: true, simulatedOcr: true }, null, 2));
  await stop(next);
});
it("HTTP failure is appended to real Review by its own role; redelivery never re-calls", async () => {
  const worker = await launch("business-node-review"), task = input(), before = ocrCalls; mode = "fail";
  try {
    const outcome = await (await start(task)).result() as OcrActivityOutcome;
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "review", code: "OCR.HTTP_STATUS" });
    if (outcome.status !== "review") throw Error();
    expect(await new PostgresReviews(db.pool).read(outcome.reviewId)).toMatchObject({ failure: { automaticRetry: false, operationId: task.operationId } });
    expect(await new PostgresResultRegistry(db.pool).read(task.operationId)).toBeNull();
    expect(await (await start(task)).result()).toMatchObject({ status: "review", code: "OCR.EXECUTION_UNKNOWN" });
    expect(ocrCalls - before).toBe(1);
  } finally { mode = "ok"; await stop(worker); }
});
it("S3 failure before invocation produces persisted Review, not an OCR call or false completion", async () => {
  const worker = await launch("business-node-store"), task = input(), before = ocrCalls; denyWrites = true;
  try {
    const outcome = await (await start(task)).result() as OcrActivityOutcome;
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "review", code: "OCR.INTENT_UNKNOWN" });
    if (outcome.status !== "review") throw Error();
    expect(await new PostgresReviews(db.pool).read(outcome.reviewId)).not.toBeNull();
    expect(await new PostgresResultRegistry(db.pool).read(task.operationId)).toBeNull();
    expect(ocrCalls).toBe(before);
    expect(calls.filter(c => c.method === "PUT" && c.key.includes(task.operationId))).toHaveLength(1);
  } finally { denyWrites = false; await stop(worker); }
});
it("upload failure after OCR preserves full candidate in PostgreSQL and redelivery does not reprocess or auto-upload", async () => {
  const worker = await launch("business-node-handoff"), task = input(), before = ocrCalls; denyResults = true;
  try {
    const outcome = await (await start(task)).result() as OcrActivityOutcome;
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "review" });
    if (outcome.status !== "review") throw Error();
    expect(await new PostgresReviews(db.pool).read(outcome.reviewId)).toMatchObject({
      failure: { executionFact: "executed", automaticRetry: false }, candidate: { schema: "ocr-output/2", value: { rawResponse: reply } },
    });
    expect(await new PostgresResultRegistry(db.pool).read(task.operationId)).toBeNull();
    expect(ocrCalls - before).toBe(1);
    expect(calls.filter(c => c.method === "PUT" && c.key.includes(task.operationId) && c.key.endsWith("/result.json"))).toHaveLength(1);
    denyResults = false;
    const puts = calls.filter(c => c.method === "PUT").length;
    expect(await (await start(task)).result()).toMatchObject({ status: "review", code: "OCR.HANDOFF_INCOMPLETE" });
    expect(calls.filter(c => c.method === "PUT")).toHaveLength(puts);
    expect(ocrCalls - before).toBe(1);
  } finally { denyResults = false; await stop(worker); }
});
