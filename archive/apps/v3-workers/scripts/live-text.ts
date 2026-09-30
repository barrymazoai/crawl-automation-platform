// Explicit one-sample real acceptance. Not a scheduled test, production deployment or retry runner.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, lstat, unlink } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEnv, promisify } from "node:util";
import assert from "node:assert/strict";
import { z } from "zod";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { startTestDatabase } from "../../v3-api/integration/postgres.js";
import { fixture } from "../../../packages/v3-text/src/testing.fixture.js";
import { createR2Objects, R2ScopeSchema, sha256 } from "@crawl-automation/v3-artifacts";
import { CodexTextConfigSchema, CodexTextProvider, CodexRpc, codexTextConnection, PostgresTextRegistry, hashText } from "@crawl-automation/v3-text";
import { TextInputSchema, TextOutputSchema, textFingerprint, assertTextQuotes, type TextInput } from "@crawl-automation/v3-contracts";

const [flag, rootArg, credentialsPath, authPath, executable, model, effort] = process.argv.slice(2);
if (flag !== "--authorized-one" || ![rootArg, credentialsPath, authPath, executable].every(p => p && isAbsolute(p)) || !model || !effort)
  throw Error("Explicit opt-in, absolute private paths, model and effort required");
const root = rootArg!, id = randomUUID(), prefix = `text-live/${id}`, exec = promisify(execFile), entry = resolve("dist/text-worker.js");
const codexHome = join(root, "codex-profile"), auditRoot = join(root, "audit");
const sample = "Serving Size: 1 capsule\nVitamin C 10 mg\nIngredients: water, cellulose";
const children: ChildProcess[] = [], handles: Awaited<ReturnType<TestWorkflowEnvironment["client"]["workflow"]["start"]>>[] = [];
let db: Awaited<ReturnType<typeof startTestDatabase>> | undefined, temporal: TestWorkflowEnvironment | undefined;
let workflow: Worker | undefined, running: Promise<void> | undefined, remote: ReturnType<typeof createR2Objects> | undefined;
let resultUrl = "", reviewUrl = "", compatibility = "", buildId = "", stage = "preflight", owned = false;
let workerCredentials: object;
const report: Record<string, any> = { id, prefix, root, startedAt: new Date().toISOString(), status: "running", maxBusinessExecutions: 1,
  internalModelRequests: "codex-managed-not-counted", realCodex: true, realR2: true, sampleKind: "synthetic-text",
  temporal: "isolated-local", database: "new-isolated-postgres", productionDeployment: false, objects: [], histories: [] };
const signal = () => AbortSignal.timeout(30000);
const codexConfig = (host: string) => CodexTextConfigSchema.parse({ settings: { provider: "openai", model, reasoningEffort: effort },
  executable, codexHome, workRoot: join(root, host, "codex-work"), runtimeProfileVersion: "real-text-0153/1", timeoutMs: 240000 });
async function save() { if (owned) await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); }
async function until(check: () => boolean | Promise<boolean>, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (!await check()) { if (Date.now() > end) throw Error("LIVE_WAIT_TIMEOUT"); await new Promise(r => setTimeout(r, 100)); }
}
async function privateBytes(path: string) {
  const s = await lstat(path); assert.ok(s.isFile() && !s.isSymbolicLink() && !(s.mode & 0o077) && s.size <= 65536);
  return readFile(path);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try { await until(() => child.exitCode !== null || child.signalCode !== null, 15000); }
  finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await until(() => child.signalCode !== null, 5000); } }
  assert.equal(child.exitCode, 0);
}
async function settings(host: string) {
  const path = join(root, `${host}-text.json`);
  await writeFile(path, JSON.stringify({ ...workerCredentials, codex: codexConfig(host), storageId: `text-live-${id}`,
    cacheRoot: join(root, host, "cache"), ocrJournalRoot: join(root, host, "ocr-journal"), textLocalRoot: join(root, host, "text-evidence"),
    resultDatabase: { connectionString: resultUrl, tls: false }, reviewDatabase: { connectionString: reviewUrl, tls: false } }), { mode: 0o600, flag: "wx" });
  return path;
}
async function launch(host: string) {
  const config = await settings(host), runtime = join(root, `${host}-worker.json`);
  await writeFile(runtime, JSON.stringify({ role: "codex-text", capability: "codex.text", contractVersion: 1, compatibility, expectedBuildId: buildId,
    hostId: host, namespace: "default", address: temporal!.address, transport: { mode: "local" }, concurrency: 1, shutdownGraceMs: 5000, shutdownForceMs: 10000 }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", resolve("scripts/live-text-audit.mjs"), entry], { env: { ...process.env,
    V3_TEXT_AUDIT_ENABLED: "true", V3_TEXT_AUDIT_CONFIG: join(root, "audit-config.json"),
    V3_TEXT_LIVE_ENABLED: "true", V3_TEXT_CONFIG: config, V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: runtime }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); let logs = "";
  const append = (b: Buffer) => { logs = (logs + b.toString()).slice(-30000); };
  child.stdout!.on("data", append); child.stderr!.on("data", append);
  await until(() => { if (child.exitCode !== null || child.signalCode !== null) throw Error("LIVE_WORKER_EXITED"); return logs.includes('"event":"WORKER_RUNNING"'); }, 60000);
  return child;
}
async function start(task: TextInput) {
  const h = await temporal!.client.workflow.start("BusinessTextProbe", { taskQueue: "live-text-acceptance-workflow", workflowId: `live-text-${randomUUID()}`,
    args: [{ task, queue: `v3.codex.text.v1.${compatibility}` }], workflowExecutionTimeout: "6 minutes" }); handles.push(h); return h;
}
async function main() {
  await mkdir(root, { mode: 0o700 }); owned = true;
  await writeFile(join(root, "run-intent.json"), JSON.stringify({ id, prefix, maxBusinessExecutions: 1 }), { mode: 0o600, flag: "wx" }); await save();
  const env = parseEnv((await privateBytes(credentialsPath!)).toString()); assert.equal(env.CLOUDFLARE_R2_BUCKET, "supply-smart-test");
  const scope = R2ScopeSchema.parse({ endpoint: env.CLOUDFLARE_R2_ENDPOINT, bucket: env.CLOUDFLARE_R2_BUCKET, prefix, timeoutMs: 20000 });
  const credentials = z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }).parse({ accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID, secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY });
  workerCredentials = { r2: scope, r2Credentials: credentials }; report.bucket = scope.bucket; report.settings = codexConfig("metadata").settings;
  const authBytes = await privateBytes(authPath!), auth = JSON.parse(authBytes.toString()); assert.equal(auth.auth_mode, "chatgpt");
  await mkdir(codexHome, { mode: 0o700 });
  await writeFile(join(codexHome, "auth.json"), authBytes, { mode: 0o600, flag: "wx" });
  await writeFile(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: "wx" });
  stage = "codex-preflight";
  const config = codexConfig("preflight"), provider = await CodexTextProvider.open(config, process.env);
  try { await provider.check(signal()); } finally { await provider.close(); }
  const rpc = new CodexRpc(codexTextConnection(config, config.workRoot, process.env));
  try { await rpc.initialize(signal()); const account = await rpc.request("account/read", { refreshToken: false }, signal()) as { account?: { type?: string } };
    assert.equal(account.account?.type, "chatgpt"); report.authMode = account.account.type;
  } finally { await rpc.close(); }
  report.codexVersion = (await exec(executable!, ["--version"])).stdout.trim(); await save();
  await mkdir(auditRoot, { mode: 0o700 });
  await writeFile(join(root, "audit-config.json"), JSON.stringify({ root: auditRoot, executable, r2Origin: scope.endpoint, pathPrefix: `/${scope.bucket}/${prefix}/` }), { mode: 0o600 });
  stage = "database"; db = await startTestDatabase({ tcp: true }); report.databaseRoot = db.root;
  for (const [role, table] of [["text_result", "processing_result"], ["text_review", "review_record"]]) {
    const password = randomUUID(); await db.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await db.pool.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT ON ${table} TO ${role}`);
    const url = new URL(db.databaseUrl!); url.username = role!; url.password = password;
    if (role === "text_result") resultUrl = url.href; else reviewUrl = url.href;
  }
  const metadata = JSON.parse((await exec(process.execPath, [entry, "--list"], { env: { ...process.env, V3_TEXT_LIVE_ENABLED: "true", V3_TEXT_CONFIG: await settings("metadata") } })).stdout)[0];
  compatibility = metadata.compatibility; buildId = metadata.buildId; report.buildId = buildId;
  stage = "temporal"; temporal = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false, executable: { type: "cached-download", version: "v1.8.3" } } });
  workflow = await Worker.create({ connection: temporal.nativeConnection, taskQueue: "live-text-acceptance-workflow", workflowBundle: { codePath: resolve(".local/test-dist/text-workflows.cjs") } });
  running = workflow.run();
  const f = fixture(sample), input = { ...f.input, ...CodexTextProvider.describe(config) }; input.inputFingerprint = textFingerprint(input, hashText);
  const task = TextInputSchema.parse(input); report.task = task; report.sample = sample;
  remote = createR2Objects(scope, credentials); stage = "source-upload";
  for (const [key, bytes] of f.remote.data) {
    report.objects.push({ key, sha256: sha256(bytes), byteSize: bytes.length }); await save();
    assert.equal(await remote.store.create(key, bytes, key.endsWith("html") ? "text/html" : "application/json", signal()), "created");
  }
  stage = "business-execution"; const h = await start(task);
  await until(async () => !!(await h.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes), 15000);
  assert.ok(!(await h.fetchHistory()).events?.some(e => e.activityTaskStartedEventAttributes));
  const a = await launch("text-live-node-a"); report.firstPid = a.pid;
  const outcome = await h.result(); report.outcome = outcome; await save(); assert.equal((outcome as { status: string }).status, "registered");
  stage = "result-verification";
  const record = await new PostgresTextRegistry(db.pool).read(task.operationId); assert.ok(record);
  for (const ref of [record.result, record.completion]) {
    const data = await remote.store.read(ref.objectKey, ref.byteSize, signal()); assert.ok(data); assert.equal(sha256(data), ref.sha256);
    report.objects.push({ key: ref.objectKey, sha256: ref.sha256, byteSize: ref.byteSize });
    if (ref === record.result) {
      const output = TextOutputSchema.parse(JSON.parse(Buffer.from(data).toString())); assertTextQuotes(output.candidate, task, sample);
      if ("codec" in output.candidate) throw Error("Legacy acceptance requires legacy output");
      assert.ok(output.candidate.formula && output.candidate.ingredients);
      assert.ok(output.candidate.formula.nutrients.some(n => n.name.text === "Vitamin C" && n.amount?.text === "10 mg"));
      assert.ok(output.candidate.ingredients.items.map(i => i.text).join(", ").includes("water"));
      assert.ok(output.candidate.ingredients.items.map(i => i.text).join(", ").includes("cellulose")); report.candidate = output.candidate;
      await writeFile(join(root, "result.json"), data, { mode: 0o600, flag: "wx" });
    }
  }
  await stop(a); console.log(JSON.stringify({ stage: "single-passed", root }));
  await writeFile(join(auditRoot, "read-only"), "", { mode: 0o600, flag: "wx" });
  stage = "fresh-cache-recovery"; const b = await launch("text-live-node-b"); report.replacementPid = b.pid;
  assert.deepEqual(await (await start(task)).result(), outcome); await stop(b);
  const events = await Promise.all((await readdir(auditRoot)).filter(n => n.startsWith("event-")).map(async n => JSON.parse(await readFile(join(auditRoot, n), "utf8"))));
  report.audit = events; assert.equal(events.filter(e => e.kind === "denied").length, 0); assert.equal(events.filter(e => e.kind === "business-turn").length, 1);
  report.resultRows = Number((await db.pool.query("SELECT count(*) AS n FROM processing_result")).rows[0].n);
  report.reviewRows = Number((await db.pool.query("SELECT count(*) AS n FROM review_record")).rows[0].n); assert.equal(report.resultRows, 1); assert.equal(report.reviewRows, 0);
  const key = `text-intents/${task.operationId}.json`, intent = await remote.store.read(key, 524288, signal()); assert.ok(intent);
  report.objects.push({ key, sha256: sha256(intent), byteSize: intent.length });
  const fresh = createR2Objects(scope, credentials);
  try { for (const o of report.objects) { const bytes = await fresh.store.read(o.key, o.byteSize, signal()); assert.ok(bytes); assert.equal(sha256(bytes), o.sha256); } }
  finally { fresh.close(); }
  report.status = "passed"; stage = "complete";
}
await main().catch(error => {
  report.status = "failed"; report.failedStage = stage; report.errorCode = typeof error?.code === "string" ? error.code : "LIVE_CHECK_FAILED"; process.exitCode = 1;
  console.error(JSON.stringify({ event: "LIVE_TEXT_FAILED", stage, code: report.errorCode, root, action: "inspect evidence; do not rerun" }));
}).finally(async () => {
  const cleanup: string[] = [];
  for (const child of children) try { await stop(child); } catch { cleanup.push("worker-stop"); }
  for (const h of handles) try {
    const history = await h.fetchHistory(); report.histories.push({ workflowId: h.workflowId, runId: h.firstExecutionRunId,
      activityIdentities: history.events?.filter(e => e.activityTaskStartedEventAttributes).map(e => e.activityTaskStartedEventAttributes?.identity),
      maxAttempts: history.events?.filter(e => e.activityTaskScheduledEventAttributes).map(e => e.activityTaskScheduledEventAttributes?.retryPolicy?.maximumAttempts) });
    await writeFile(join(root, `${h.workflowId}-history.json`), JSON.stringify(history), { mode: 0o600 });
  } catch { cleanup.push("history"); }
  if (workflow) try { workflow.shutdown(); await running; } catch { cleanup.push("workflow-stop"); }
  if (temporal) try { await temporal.teardown(); } catch { cleanup.push("temporal-stop"); }
  if (db) try { report.databaseEvidence = { results: (await db.pool.query("SELECT record,record_hash FROM processing_result")).rows,
    reviews: (await db.pool.query("SELECT record,record_hash FROM review_record")).rows }; } catch { cleanup.push("database-evidence"); }
  if (db) try { await db.close(); } catch { cleanup.push("database-stop"); }
  remote?.close();
  if (owned) try { await unlink(join(codexHome, "auth.json")); report.temporaryAuthRemoved = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") cleanup.push("auth-cleanup"); }
  report.cleanupIssues = cleanup; report.finishedAt = new Date().toISOString(); if (cleanup.length) { report.status = "cleanup-incomplete"; process.exitCode = 1; }
  await save(); console.log(JSON.stringify({ status: report.status, root, prefix, cleanupIssues: cleanup }));
});
