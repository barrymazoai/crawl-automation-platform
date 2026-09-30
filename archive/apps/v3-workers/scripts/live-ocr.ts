// Explicit acceptance runner. Not a test suite, daemon, migration of an existing DB or production workflow.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { z } from "zod";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { startTestDatabase } from "../../v3-api/integration/postgres.js";
import { fixture } from "../../../packages/v3-results/src/testing.fixture.js";
import { MultipartOcr } from "@crawl-automation/v3-ocr";
import { createR2Objects, R2ScopeSchema, sha256 } from "@crawl-automation/v3-artifacts";
import { PostgresResultRegistry, verifyCompletion } from "@crawl-automation/v3-results";
import { OcrInputSchema, OcrOutputSchema, fingerprintOcrInput, type OcrInput } from "@crawl-automation/v3-contracts";

const exec = promisify(execFile);
const [flag, rootArg, credentialsPath, samplesRoot] = process.argv.slice(2);
if (flag !== "--authorized-three" || !rootArg || !credentialsPath || !samplesRoot || ![rootArg, credentialsPath, samplesRoot].every(isAbsolute)) throw Error("Explicit absolute paths and three-call opt-in required");
const root = rootArg, entry = resolve("dist/ocr-worker.js"), id = randomUUID(), prefix = `ocr-live/${id}`;
const config = { endpoint: "http://192.168.0.6:8081/ocr", trustedHttpOrigin: "http://192.168.0.6:8081", minScore: 0.3, provider: "local-paddle/ppocr-v5-mobile-en" };
const provider = new MultipartOcr(config);
const children: ChildProcess[] = [];
const workflowHandles: Awaited<ReturnType<TestWorkflowEnvironment["client"]["workflow"]["start"]>>[] = [];
let db: Awaited<ReturnType<typeof startTestDatabase>> | undefined, temporal: TestWorkflowEnvironment | undefined;
let workflow: Worker | undefined, running: Promise<void> | undefined, remote: ReturnType<typeof createR2Objects> | undefined;
let resultUrl = "", reviewUrl = "", compatibility = "", buildId = "", stage = "preflight";
let workerCredentials: object;
const report: Record<string, unknown> = { id, prefix, root, startedAt: new Date().toISOString(), maxOcrCalls: 3, status: "running",
  realOcr: true, realR2: true, temporal: "isolated-local", database: "new-isolated-postgres", productionDeployment: false,
  objects: [], outcomes: [], histories: [] };
const signal = () => AbortSignal.timeout(30000);
async function save() { await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); }
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (!await predicate()) { if (Date.now() >= end) throw Error("LIVE_WAIT_TIMEOUT"); await new Promise(r => setTimeout(r, 100)); }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try { await until(() => child.exitCode !== null || child.signalCode !== null, 15000); }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  assert.equal(child.exitCode, 0);
}
async function settings(host: string) {
  const path = join(root, `${host}-ocr.json`);
  await writeFile(path, JSON.stringify({ ...workerCredentials, provider: config, storageId: `ocr-live-${id}`,
    cacheRoot: join(root, host, "cache"), journalRoot: join(root, host, "journal"),
    resultDatabase: { connectionString: resultUrl, tls: false }, reviewDatabase: { connectionString: reviewUrl, tls: false } }), { mode: 0o600, flag: "wx" });
  return path;
}
async function launch(host: string) {
  const ocrPath = await settings(host), runtime = join(root, `${host}-runtime.json`);
  await writeFile(runtime, JSON.stringify({ role: "ocr-file", capability: "ocr.file", contractVersion: 1, compatibility,
    expectedBuildId: buildId, hostId: host, namespace: "default", address: temporal!.address, transport: { mode: "local" },
    concurrency: 2, shutdownGraceMs: 5000, shutdownForceMs: 15000 }), { mode: 0o600, flag: "wx" });
  const childEnv = { ...process.env };
  // No inherited acceptance transport rewriting or Node runtime injection.
  delete childEnv.NODE_OPTIONS; delete childEnv.V3_TEST_S3_PORT;
  const child = spawn(process.execPath, ["--import", resolve("scripts/live-audit.mjs"), entry], {
    env: { ...childEnv, V3_OCR_LIVE_ENABLED: "true", V3_OCR_CONFIG: ocrPath, V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: runtime,
      V3_LIVE_AUDIT_ENABLED: "true", V3_LIVE_AUDIT_CONFIG: join(root, "audit-config.json") }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); let logs = "";
  child.stdout!.on("data", b => { logs = (logs + String(b)).slice(-40000); });
  child.stderr!.on("data", b => { logs = (logs + String(b)).slice(-40000); });
  await until(() => { if (child.exitCode !== null) throw Error("LIVE_WORKER_STARTUP"); return logs.includes('"event":"WORKER_RUNNING"'); }, 40000);
  return child;
}
async function start(task: OcrInput) {
  const handle = await temporal!.client.workflow.start("BusinessOcrProbe", { taskQueue: "live-ocr-acceptance-workflow",
    workflowId: `ocr-live-${randomUUID()}`, args: [{ task, queue: `v3.ocr.file.v1.${compatibility}` }], workflowExecutionTimeout: "3 minutes" });
  workflowHandles.push(handle); return handle;
}
const sampleSchema = z.object({ label: z.enum(["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO"]), filename: z.string().regex(/^[A-Z]+\.png$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().positive().max(100000), expectedRows: z.array(z.string()) });
async function verify(task: OcrInput, expected: string, label: string) {
  const record = await new PostgresResultRegistry(db!.pool).read(task.operationId); assert.ok(record);
  const result = await remote!.store.read(record.result.objectKey, record.result.byteSize, signal());
  const completion = await remote!.store.read(record.completion.objectKey, record.completion.byteSize, signal());
  const source = await remote!.store.read(task.file.objectKey, task.file.byteSize, signal());
  assert.ok(result && completion && source); assert.equal(sha256(source), task.file.sha256);
  verifyCompletion(record, result, completion);
  const output = OcrOutputSchema.parse(JSON.parse(Buffer.from(result).toString())); assert.equal(output.resultSchemaVersion, 2);
  if (output.resultSchemaVersion !== 2) throw Error();
  assert.equal(output.text, expected); assert.equal(output.rawResponse.lines.length, 5);
  assert.ok(output.rawResponse.lines.every(l => l.polygon?.length === 4));
  await writeFile(join(root, `${label}-result.json`), result, { mode: 0o600, flag: "wx" });
  (report.objects as unknown[]).push({ key: record.result.objectKey, sha256: record.result.sha256, byteSize: record.result.byteSize },
    { key: record.completion.objectKey, sha256: record.completion.sha256, byteSize: record.completion.byteSize });
  (report.outcomes as unknown[]).push({ label, operationId: task.operationId, artifactId: task.file.artifactId, exactText: true,
    rawResponse: output.rawResponse, result: record.result, completion: record.completion });
  await save();
}
async function main() {
  // This run cannot be automatically resumed/restarted, including after partial network effects.
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "run-intent.json"), JSON.stringify({ id, prefix, maxOcrCalls: 3 }), { mode: 0o600, flag: "wx" });
  await save();
  const info = await lstat(credentialsPath!); assert.ok(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077));
  const env = parseEnv(await readFile(credentialsPath!, "utf8"));
  assert.equal(env.CLOUDFLARE_R2_BUCKET, "supply-smart-test");
  const scope = R2ScopeSchema.parse({ endpoint: env.CLOUDFLARE_R2_ENDPOINT, bucket: env.CLOUDFLARE_R2_BUCKET, prefix });
  const credentials = z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }).parse({
    accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID, secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY });
  workerCredentials = { r2: scope, r2Credentials: credentials }; report.bucket = scope.bucket;
  const samples = z.array(sampleSchema).parse(JSON.parse(await readFile(join(samplesRoot!, "samples.json"), "utf8"))).slice(0, 3);
  assert.deepEqual(samples.map(s => s.label), ["ALPHA", "BRAVO", "CHARLIE"]);
  const tasks: OcrInput[] = [];
  for (const sample of samples) {
    const bytes = await readFile(join(samplesRoot!, sample.filename)); assert.equal(sha256(bytes), sample.sha256); assert.equal(bytes.length, sample.byteSize);
    const task = fixture().input; Object.assign(task, provider.supported);
    task.file.sha256 = sample.sha256; task.file.byteSize = sample.byteSize;
    task.inputFingerprint = fingerprintOcrInput(task, text => sha256(Buffer.from(text)));
    tasks.push(OcrInputSchema.parse(task));
  }
  report.tasks = tasks; await save();
  await mkdir(join(root, "audit"), { mode: 0o700 });
  await writeFile(join(root, "audit-config.json"), JSON.stringify({ root: join(root, "audit"), r2Origin: scope.endpoint,
    pathPrefix: `/${scope.bucket}/${prefix}/`, ocrEndpoint: `${config.endpoint}?min_score=0.3` }), { mode: 0o600 });
  stage = "database"; db = await startTestDatabase({ tcp: true }); report.databaseRoot = db.root;
  for (const [role, table] of [["ocr_result", "processing_result"], ["ocr_review", "review_record"]]) {
    const password = randomUUID();
    await db.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await db.pool.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT ON ${table} TO ${role}`);
    const url = new URL(db.databaseUrl!); url.username = role!; url.password = password;
    if (role === "ocr_result") resultUrl = url.href; else reviewUrl = url.href;
  }
  const metadataPath = await settings("metadata");
  const metadata = JSON.parse((await exec(process.execPath, [entry, "--list"], { env: { ...process.env, V3_OCR_LIVE_ENABLED: "true", V3_OCR_CONFIG: metadataPath } })).stdout)[0];
  compatibility = metadata.compatibility; buildId = metadata.buildId; report.buildId = buildId;
  temporal = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false, executable: { type: "cached-download", version: "v1.8.3" } } });
  workflow = await Worker.create({ connection: temporal.nativeConnection, taskQueue: "live-ocr-acceptance-workflow",
    workflowBundle: { codePath: resolve(".local/test-dist/ocr-workflows.cjs") } });
  running = workflow.run(); running.catch(() => {});
  remote = createR2Objects(scope, credentials); stage = "source-upload";
  for (let n = 0; n < tasks.length; n++) {
    const task = tasks[n]!, sample = samples[n]!;
    (report.objects as unknown[]).push({ key: task.file.objectKey, sha256: task.file.sha256, byteSize: task.file.byteSize }); await save();
    assert.equal(await remote.store.create(task.file.objectKey, await readFile(join(samplesRoot!, sample.filename)), "image/png", signal()), "created");
  }
  stage = "single"; const first = await start(tasks[0]!);
  await until(async () => !!(await first.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes), 15000);
  assert.ok(!(await first.fetchHistory()).events?.some(e => e.activityTaskStartedEventAttributes));
  const a = await launch("live-node-a"); report.firstPid = a.pid;
  assert.equal((await first.result() as { status: string }).status, "registered");
  await verify(tasks[0]!, samples[0]!.expectedRows.join("\n"), samples[0]!.label);
  console.log(JSON.stringify({ stage: "single-passed", root }));
  stage = "parallel";
  const pair = await Promise.all(tasks.slice(1).map(start));
  const outcomes = await Promise.all(pair.map(h => h.result())); assert.ok(outcomes.every(o => (o as { status: string }).status === "registered"));
  for (let n = 1; n < tasks.length; n++) await verify(tasks[n]!, samples[n]!.expectedRows.join("\n"), samples[n]!.label);
  console.log(JSON.stringify({ stage: "parallel-passed", root }));
  await stop(a);
  // Budget audit makes any hidden new OCR/PUT an explicit failed recovery, never a silent extra call.
  await writeFile(join(root, "audit", "read-only"), "", { mode: 0o600, flag: "wx" });
  stage = "fresh-cache-recovery"; const b = await launch("live-node-b"); report.replacementPid = b.pid;
  for (const task of tasks) assert.equal((await (await start(task)).result() as { status: string }).status, "registered");
  await stop(b);
  for (const h of workflowHandles) {
    const history = await h.fetchHistory();
    (report.histories as unknown[]).push({ workflowId: h.workflowId, runId: h.firstExecutionRunId,
      activityIdentities: history.events?.filter(e => e.activityTaskStartedEventAttributes).map(e => e.activityTaskStartedEventAttributes?.identity),
      maxAttempts: history.events?.filter(e => e.activityTaskScheduledEventAttributes).map(e => e.activityTaskScheduledEventAttributes?.retryPolicy?.maximumAttempts) });
    await writeFile(join(root, `${h.workflowId}-history.json`), JSON.stringify(history), { mode: 0o600 });
  }
  const events = await Promise.all((await readdir(join(root, "audit"))).filter(n => n.startsWith("event-")).map(async n => JSON.parse(await readFile(join(root, "audit", n), "utf8"))));
  report.audit = events; assert.equal(events.filter(e => e.kind === "denied").length, 0);
  assert.equal(events.filter(e => e.kind === "start" && e.service === "ocr").length, 3);
  report.resultRows = Number((await db.pool.query("SELECT count(*) AS n FROM processing_result")).rows[0].n);
  report.reviewRows = Number((await db.pool.query("SELECT count(*) AS n FROM review_record")).rows[0].n);
  assert.equal(report.resultRows, 3); assert.equal(report.reviewRows, 0);
  for (const task of tasks) {
    const key = `ocr-intents/${task.operationId}.json`, data = await remote.store.read(key, 65536, signal()); assert.ok(data);
    (report.objects as unknown[]).push({ key, sha256: sha256(data), byteSize: data.length });
  }
  // Fresh R2 client, all exact keys, no ListBucket or deletion permissions needed.
  const fresh = createR2Objects(scope, credentials);
  try { for (const object of report.objects as { key: string; sha256: string; byteSize: number }[]) {
    const data = await fresh.store.read(object.key, object.byteSize, signal()); assert.ok(data); assert.equal(sha256(data), object.sha256);
  } } finally { fresh.close(); }
  report.status = "passed"; stage = "complete";
}
await main().catch(async () => {
  report.status = "failed"; report.failedStage = stage; process.exitCode = 1;
  console.error(JSON.stringify({ event: "LIVE_ACCEPTANCE_FAILED", stage, root, action: "inspect evidence; do not rerun" }));
}).finally(async () => {
  const cleanup: string[] = [];
  for (const child of children) try { await stop(child); } catch { cleanup.push("worker-stop"); }
  if (workflow) try { workflow.shutdown(); await running; } catch { cleanup.push("workflow-stop"); }
  if (temporal) try { await temporal.teardown(); } catch { cleanup.push("temporal-stop"); }
  if (db) try {
    report.databaseEvidence = { results: (await db.pool.query("SELECT record,record_hash FROM processing_result")).rows,
      reviews: (await db.pool.query("SELECT record,record_hash FROM review_record")).rows };
  } catch { cleanup.push("database-evidence"); }
  if (db) try { await db.close(); } catch { cleanup.push("database-stop"); }
  remote?.close(); report.cleanupIssues = cleanup; report.finishedAt = new Date().toISOString();
  if (cleanup.length) { report.status = "cleanup-incomplete"; process.exitCode = 1; }
  // Preserve valid existing reports if startup refused an already-used run directory.
  try { const intent = JSON.parse(await readFile(join(root, "run-intent.json"), "utf8")); if (intent.id === id) await save(); } catch { /* no owned run */ }
  console.log(JSON.stringify({ status: report.status, root, prefix, cleanupIssues: cleanup }));
});
