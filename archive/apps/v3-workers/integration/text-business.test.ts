import { createServer as httpsServer } from "node:https";
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
import { CodexTextProvider, PostgresTextRegistry, hashText } from "@crawl-automation/v3-text";
import { textFingerprint, type TextInput } from "@crawl-automation/v3-contracts";
import { pageInput, sign } from "../../../packages/v3-acquisition/src/testing.fixture.js";
import { pageCompletionKey } from "@crawl-automation/v3-acquisition";
import { fixture } from "../../../packages/v3-text/src/testing.fixture.js";
import { startTestDatabase } from "../../v3-api/integration/postgres.js";
import { nutritionPdf, inputFor as pdfInputFor } from "../../../packages/v3-pdf/integration/helpers.js";
import { fingerprintPdfInput, pdfConfigFingerprint, pdfCompletionKey } from "@crawl-automation/v3-pdf";

const exec = promisify(execFile), entry = resolve("dist/text-worker.js");
const fakeHost = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com", bucket = "synthetic-only", prefix = `business-text/${randomUUID()}`;
const objects = new Map<string, Buffer>(), children: ChildProcess[] = [];
let root: string, codexHome: string, executable: string, port: number, writes = 0, denyResults = false, denyPageDocument = false, pageDocumentPuts = 0;
let resultUrl: string, reviewUrl: string, readonlyResultUrl: string;
let db: Awaited<ReturnType<typeof startTestDatabase>>, temporal: TestWorkflowEnvironment;
let s3: ReturnType<typeof httpsServer>, workflow: Worker, running: Promise<void>;
let preparedWorkflow: Worker, preparedRunning: Promise<void>;
let metadata: { buildId: string; compatibility: string }, queue: string;
const pathFor = (key: string) => `/${bucket}/${prefix}/${key}`;
const codexConfig = (host: string) => ({ settings: { provider: "fixture", model: "fixture-model", reasoningEffort: "high" },
  executable, codexHome, workRoot: join(root, host, "codex-work"), timeoutMs: 10000, runtimeProfileVersion: "business-fixture/1" });
async function executions() {
  try { return (await readFile(join(codexHome, "executions.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function config(host: string) {
  const path = join(root, `${host}-text.json`);
  await writeFile(path, JSON.stringify({ codex: codexConfig(host), storageId: "isolated-s3/1",
    cacheRoot: join(root, host, "cache"), ocrJournalRoot: join(root, host, "ocr-journal"), textLocalRoot: join(root, host, "text-evidence"),
    r2: { endpoint: `https://${fakeHost}`, bucket, prefix, timeoutMs: 2000 },
    r2Credentials: { accessKeyId: "synthetic-key", secretAccessKey: "synthetic-secret" },
    resultDatabase: { connectionString: resultUrl, tls: false }, reviewDatabase: { connectionString: reviewUrl, tls: false },
  }), { mode: 0o600 }); return path;
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "v3-text-business-"));
  codexHome = join(root, "codex-profile"); await mkdir(codexHome, { mode: 0o700 });
  await writeFile(join(codexHome, "scenario"), "ok", { mode: 0o600 });
  executable = join(root, "fixture-codex.mjs");
  await writeFile(executable, (await readFile(resolve("integration/fixtures/business-codex.mjs"), "utf8")).replace("#!/usr/bin/env node", `#!${process.execPath}`));
  await chmod(executable, 0o700);
  db = await startTestDatabase({ tcp: true });
  for (const [role, table] of [["text_result", "processing_result"], ["text_review", "review_record"]]) {
    const password = randomUUID();
    await db.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await db.pool.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT ON ${table} TO ${role}`);
    const url = new URL(db.databaseUrl!); url.username = role!; url.password = password;
    if (role === "text_result") resultUrl = url.href; else reviewUrl = url.href;
  }
  const readerPassword = randomUUID();
  await db.pool.query(`CREATE ROLE text_receipt_reader LOGIN PASSWORD '${readerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await db.pool.query("GRANT USAGE ON SCHEMA public TO text_receipt_reader; GRANT SELECT ON processing_result TO text_receipt_reader");
  const readerUrl = new URL(db.databaseUrl!); readerUrl.username = "text_receipt_reader"; readerUrl.password = readerPassword; readonlyResultUrl = readerUrl.href;
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${fakeHost}`,
    "-addext", `subjectAltName=DNS:${fakeHost}`, "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")]);
  s3 = httpsServer({ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) }, (req, res) => {
    const key = new URL(req.url!, "https://fixture").pathname;
    const fail = (status: number, code: string) => { res.writeHead(status, { "Content-Type": "application/xml" }); res.end(`<Error><Code>${code}</Code></Error>`); };
    if (!key.startsWith(`/${bucket}/${prefix}/`) || !req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) return fail(403, "AccessDenied");
    if (req.method === "GET") {
      const data = objects.get(key); if (!data) return fail(404, "NoSuchKey");
      res.writeHead(200, { "Content-Length": data.length }); res.end(data); return;
    }
    if (req.method !== "PUT" || req.headers["if-none-match"] !== "*") return fail(403, "AccessDenied");
    writes++;
    const chunks: Buffer[] = []; req.on("data", b => chunks.push(b)); req.on("end", () => {
      if (key.includes("/v3/pages/") && key.endsWith("/document.json")) { pageDocumentPuts++; if (denyPageDocument) return fail(503, "ServiceUnavailable"); }
      if (denyResults && key.endsWith("/result.json")) return fail(503, "ServiceUnavailable");
      if (objects.has(key)) return fail(412, "PreconditionFailed");
      objects.set(key, Buffer.concat(chunks)); res.writeHead(200, { ETag: '"fixture"' }); res.end();
    });
  });
  await new Promise<void>((r, reject) => { s3.once("error", reject); s3.listen(0, "127.0.0.1", r); });
  const address = s3.address(); if (!address || typeof address === "string") throw Error(); port = address.port;
  const settings = await config("metadata");
  metadata = JSON.parse((await exec(process.execPath, [entry, "--list"], { env: { ...process.env, V3_TEXT_LIVE_ENABLED: "true", V3_TEXT_CONFIG: settings } })).stdout)[0];
  expect(await executions()).toHaveLength(0);
  queue = `v3.codex.text.v1.${metadata.compatibility}`;
  temporal = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false,
    executable: process.env.V3_TEST_TEMPORAL_CLI ? { type: "existing-path", path: process.env.V3_TEST_TEMPORAL_CLI } : { type: "cached-download", version: "v1.8.3" } } });
  workflow = await Worker.create({ connection: temporal.nativeConnection, taskQueue: "business-text-fixture-workflow", workflowBundle: { codePath: resolve(".local/test-dist/text-workflows.cjs") } });
  running = workflow.run();
  preparedWorkflow = await Worker.create({ connection: temporal.nativeConnection, taskQueue: "prepared-text-workflow",
    workflowBundle: { codePath: resolve("dist/product-workflows.cjs") } });
  preparedRunning = preparedWorkflow.run();
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
  if (preparedWorkflow) { preparedWorkflow.shutdown(); await preparedRunning; }
  if (db) await writeFile(join(root, "database-proof.json"), JSON.stringify({ executions: await executions(), writes,
    results: (await db.pool.query("SELECT operation_id,record_hash FROM processing_result")).rows,
    reviews: (await db.pool.query("SELECT review_id,record->'failure' AS failure FROM review_record")).rows }, null, 2));
  await temporal?.teardown(); await db?.close();
  if (s3) { s3.closeAllConnections(); await new Promise<void>(r => s3.close(() => r())); }
  console.log(`Business text isolated evidence: ${root}; real model/R2 requests: 0`);
});
async function launch(host: string) {
  const settings = await config(host), runtime = join(root, `${host}-worker.json`);
  await writeFile(runtime, JSON.stringify({ role: "codex-text", capability: "codex.text", contractVersion: 1,
    compatibility: metadata.compatibility, expectedBuildId: metadata.buildId, hostId: host, namespace: "default", address: temporal.address,
    transport: { mode: "local" }, concurrency: 2, shutdownGraceMs: 2000, shutdownForceMs: 5000 }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", resolve("integration/fixtures/s3-loopback.mjs"), entry], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, "cert.pem"), V3_TEST_S3_PORT: String(port),
      V3_TEXT_LIVE_ENABLED: "true", V3_TEXT_CONFIG: settings, V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: runtime }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child); let logs = "";
  child.stdout!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  child.stderr!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  await vi.waitFor(() => { if (child.exitCode !== null) throw Error(logs); expect(logs).toContain('"event":"WORKER_RUNNING"'); }, { timeout: 15000 });
  return child;
}
function input(text = "Vitamin C") {
  const f = fixture(`Other ingredients: ${text}`), task = { ...f.input, ...CodexTextProvider.describe(codexConfig("input")) };
  task.inputFingerprint = textFingerprint(task, hashText);
  for (const [key, data] of f.remote.data) objects.set(pathFor(key), Buffer.from(data));
  return task;
}
const start = (task: TextInput) => temporal.client.workflow.start("BusinessTextProbe", { taskQueue: "business-text-fixture-workflow",
  workflowId: `business-text-${randomUUID()}`, args: [{ task, queue }], workflowExecutionTimeout: "1 minute" });
it("compiled independent Worker persists final evidence and replacement replays without a new Codex execution", async () => {
  const task = input(), handle = await start(task);
  await vi.waitFor(async () => expect((await handle.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes)).toBe(true));
  expect(await executions()).toHaveLength(0);
  const worker = await launch("text-node-a");
  const outcome = await handle.result(); expect(outcome).toMatchObject({ status: "registered" });
  expect(await executions()).toHaveLength(1);
  const record = await new PostgresTextRegistry(db.pool).read(task.operationId);
  expect(JSON.parse(objects.get(pathFor(record!.result.objectKey))!.toString()).candidate.ingredients.items[0].text).toBe("Vitamin C");
  await stop(worker);
  const next = await launch("text-node-b"), before = writes;
  expect(await (await start(task)).result()).toEqual(outcome);
  expect(await executions()).toHaveLength(1); expect(writes).toBe(before);
  await stop(next);
});
it("failed execution enters passive Review and redelivery never starts a replacement", async () => {
  const worker = await launch("text-node-failure"), task = input("failure"), before = (await executions()).length;
  await writeFile(join(codexHome, "scenario"), "fail");
  try {
    expect(await (await start(task)).result()).toMatchObject({ status: "review", code: "TEXT.CODEX_TURN_FAILED" });
    expect(await (await start(task)).result()).toMatchObject({ status: "review", code: "TEXT.EXECUTION_UNKNOWN" });
    expect(await executions()).toHaveLength(before + 1);
  } finally { await writeFile(join(codexHome, "scenario"), "ok"); await stop(worker); }
});
it("post-compute upload failure keeps local evidence and does not re-execute", async () => {
  const worker = await launch("text-node-handoff"), task = input("handoff"), before = (await executions()).length; denyResults = true;
  try {
    expect(await (await start(task)).result()).toMatchObject({ status: "review" });
    denyResults = false;
    expect(await (await start(task)).result()).toMatchObject({ status: "review", code: "TEXT.HANDOFF_INCOMPLETE" });
    expect(await executions()).toHaveLength(before + 1);
    expect(await new PostgresTextRegistry(db.pool).read(task.operationId)).toBeNull();
  } finally { denyResults = false; await stop(worker); }
});
it("concurrent products have distinct Codex processes and correctly attributed results", async () => {
  const worker = await launch("text-node-concurrent"), tasks = [input("SLOW product"), input("FAST product")], before = (await executions()).length;
  try {
    const handles = await Promise.all(tasks.map(start));
    expect(await Promise.all(handles.map(h => h.result()))).toEqual([expect.objectContaining({ status: "registered" }), expect.objectContaining({ status: "registered" })]);
    const runs = (await executions()).slice(before); expect(runs).toHaveLength(2);
    expect(new Set(runs.map(r => r.pid)).size).toBe(2); expect(new Set(runs.map(r => r.cwd)).size).toBe(2);
    for (const [index, task] of tasks.entries()) {
      const record = await new PostgresTextRegistry(db.pool).read(task.operationId);
      expect(JSON.parse(objects.get(pathFor(record!.result.objectKey))!.toString()).candidate.ingredients.items[0].text).toBe(index === 0 ? "SLOW product" : "FAST product");
    }
  } finally { await stop(worker); }
});

const receiptQueue = "v3.text.receipt.v1.text-receipt-v1";
async function launchReceipt(host: string) {
  const settings = await config(host), data = JSON.parse(await readFile(settings, "utf8"));
  delete data.codex; data.resultDatabase.connectionString = readonlyResultUrl;
  await writeFile(settings, JSON.stringify(data), { mode: 0o600 });
  const receiptEntry = resolve("dist/text-receipt-worker.js"), env = { ...process.env,
    NODE_EXTRA_CA_CERTS: join(root, "cert.pem"), V3_TEST_S3_PORT: String(port),
    V3_TEXT_RECEIPT_LIVE_ENABLED: "true", V3_TEXT_RECEIPT_CONFIG: settings };
  const meta = JSON.parse((await exec(process.execPath, [receiptEntry, "--list"], { env })).stdout)[0];
  expect(meta).toMatchObject({ role: "text-receipt", capability: "text.receipt", compatibility: "text-receipt-v1" });
  const runtime = join(root, `${host}-runtime.json`);
  await writeFile(runtime, JSON.stringify({ role: meta.role, capability: meta.capability, compatibility: meta.compatibility,
    contractVersion: 1, expectedBuildId: meta.buildId, hostId: host, namespace: "default", address: temporal.address,
    transport: { mode: "local" }, concurrency: 2, shutdownGraceMs: 2000, shutdownForceMs: 5000 }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", resolve("integration/fixtures/s3-loopback.mjs"), receiptEntry], {
    env: { ...env, V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: runtime }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); let logs = "";
  child.stdout!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  child.stderr!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  await vi.waitFor(() => { if (child.exitCode !== null) throw Error(logs); expect(logs).toContain('"event":"WORKER_RUNNING"'); }, { timeout: 15000 });
  return child;
}
const startPrepared = (task: TextInput, textQueue = queue, receipts = receiptQueue) => temporal.client.workflow.start("PreparedTextWorkflow", {
  taskQueue: "prepared-text-workflow", workflowId: `prepared-text-${randomUUID()}`, args: [{ task, queues: { text: textQueue, receipts } }],
  workflowExecutionTimeout: "1 minute" });
it("prepared text waits for independent receipt consumer, freeing Codex to process another product", async () => {
  const worker = await launch("prepared-text-producer"), tasks = [input("product A"), input("product B")], before = (await executions()).length;
  try {
    const handles = await Promise.all(tasks.map(t => startPrepared(t)));
    await vi.waitFor(async () => {
      for (const h of handles) expect((await h.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "resolveTextReceipt")).toBe(true);
    }, { timeout: 10000 });
    expect(await executions()).toHaveLength(before + 2);
    await stop(worker); // Neither waiting workflow needs its original Codex process.
    preparedWorkflow.shutdown(); await preparedRunning;
    preparedWorkflow = await Worker.create({ connection: temporal.nativeConnection, taskQueue: "prepared-text-workflow",
      workflowBundle: { codePath: resolve("dist/product-workflows.cjs") } });
    preparedRunning = preparedWorkflow.run(); // Replay must not enqueue completed interpretation again.
    const beforeWrites = writes, reader = await launchReceipt("prepared-receipt-empty-cache");
    try {
      const outcomes = await Promise.all(handles.map(h => h.result()));
      outcomes.forEach((o, i) => expect(o).toMatchObject({ status: "registered", registration: { input: tasks[i] } }));
      expect(await executions()).toHaveLength(before + 2); expect(writes).toBe(beforeWrites);
      await writeFile(join(root, "prepared-text-history.json"), JSON.stringify(await handles[0]!.fetchHistory(), null, 2));
      expect((await db.pool.query("SELECT has_table_privilege('text_receipt_reader','processing_result','INSERT') AS can_insert")).rows[0].can_insert).toBe(false);
    } finally { await stop(reader); }
  } finally { await stop(worker); }
});
it("prepared text failed Activity recovers existing evidence only, and unknown result stays Review", async () => {
  const producer = await launch("prepared-text-seed"), seeded = input("seeded");
  expect(await (await start(seeded)).result()).toMatchObject({ status: "registered" }); await stop(producer);
  const before = (await executions()).length, beforeWrites = writes, faultQueue = `failed-text-${randomUUID()}`;
  let attempts = 0;
  const fault = await Worker.create({ connection: temporal.nativeConnection, taskQueue: faultQueue,
    activities: { interpretText: async () => { attempts++; throw ApplicationFailure.nonRetryable("Synthetic lost receipt", "TEST.LOST_RESPONSE"); } } });
  const faultRunning = fault.run(), reader = await launchReceipt("prepared-text-recovery");
  try {
    expect(await (await startPrepared(seeded, faultQueue)).result()).toMatchObject({ status: "registered", registration: { input: seeded } });
    expect(await (await startPrepared(input("unknown"), faultQueue)).result()).toMatchObject({ status: "review", code: "TEXT_RECEIPT.TEXT_UNCONFIRMED" });
    expect(attempts).toBe(2); expect(await executions()).toHaveLength(before); expect(writes).toBe(beforeWrites);
  } finally { fault.shutdown(); await faultRunning; await stop(reader); }
});
it("prepared text upstream Review retains its ID and never gains success from receipt reconciliation", async () => {
  const producer = await launch("prepared-text-failure"), reader = await launchReceipt("prepared-text-review"), task = input("failure-review");
  const before = (await executions()).length; await writeFile(join(codexHome, "scenario"), "fail");
  try {
    const outcome = await (await startPrepared(task)).result();
    expect(outcome).toMatchObject({ status: "review", code: "TEXT.CODEX_TURN_FAILED", automaticRetry: false });
    const rows = (await db.pool.query("SELECT review_id,record->'failure' AS failure FROM review_record WHERE record->'failure'->>'operationId'=$1", [task.operationId])).rows;
    expect(rows).toHaveLength(1); expect(rows[0].review_id).toBe(outcome.reviewId);
    expect(rows[0].failure.stage).toBe("codex.text"); expect(await executions()).toHaveLength(before + 1);
  } finally { await writeFile(join(codexHome, "scenario"), "ok"); await stop(producer); await stop(reader); }
});
it("receipt entry is default-off and rejects Codex configuration rather than opening it", async () => {
  const receiptEntry = resolve("dist/text-receipt-worker.js"), before = (await executions()).length;
  await expect(exec(process.execPath, [receiptEntry, "--list"], { env: { ...process.env, V3_TEXT_RECEIPT_LIVE_ENABLED: "false" } })).rejects.toThrow();
  await expect(exec(process.execPath, [receiptEntry, "--list"], { env: { ...process.env, V3_TEXT_RECEIPT_LIVE_ENABLED: "true",
    V3_TEXT_RECEIPT_CONFIG: await config("invalid-receipt-config") } })).rejects.toThrow();
  expect(await executions()).toHaveLength(before);
});
it("cancelled queued text does not schedule receipt recovery; invalid plan fails before any Activity", async () => {
  const before = (await executions()).length, task = input("cancelled"), handle = await startPrepared(task, `absent-${randomUUID()}`);
  await vi.waitFor(async () => expect((await handle.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes)).toBe(true));
  await handle.cancel(); await expect(handle.result()).rejects.toThrow();
  expect((await handle.fetchHistory()).events?.filter(e => e.activityTaskScheduledEventAttributes).map(e => e.activityTaskScheduledEventAttributes!.activityType!.name)).toEqual(["interpretText"]);
  const invalid = await startPrepared({ ...task, resultSchemaVersion: 1 });
  await expect(invalid.result()).rejects.toThrow();
  expect((await invalid.fetchHistory()).events?.filter(e => e.activityTaskScheduledEventAttributes)).toHaveLength(0);
  expect(await executions()).toHaveLength(before);
});
it("foreign or malformed receipt terminates the workflow without rerunning interpretation", async () => {
  const fakeQueue = `invalid-receipt-${randomUUID()}`, before = (await executions()).length;
  let interprets = 0, mode = "foreign";
  const fake = await Worker.create({ connection: temporal.nativeConnection, taskQueue: fakeQueue, activities: {
    interpretText: async () => { interprets++; throw ApplicationFailure.nonRetryable("Synthetic missing response", "TEST.LOST_RESPONSE"); },
    resolveTextReceipt: async () => mode === "foreign" ? { status: "review", operationId: "foreign-operation", reviewId: "synthetic-review",
      code: "TEXT.CODEX_TURN_FAILED", automaticRetry: false } : { status: "registered" },
  } });
  const run = fake.run();
  try {
    for (const value of ["foreign", "malformed"]) {
      mode = value;
      const handle = await startPrepared(input(value), fakeQueue, fakeQueue);
      await expect(handle.result()).rejects.toThrow();
      const history = await handle.fetchHistory();
      expect(history.events?.filter(e => e.activityTaskScheduledEventAttributes).map(e => e.activityTaskScheduledEventAttributes!.activityType!.name)).toEqual(["interpretText", "resolveTextReceipt"]);
      expect(history.events?.some(e => e.workflowExecutionFailedEventAttributes)).toBe(true);
    }
    expect(interprets).toBe(2); expect(await executions()).toHaveLength(before);
  } finally { fake.shutdown(); await run; }
});

function htmlPlan(html = '<table><tr><td>Other ingredients: water</td></tr></table><script>fetch("https://example.test")</script><img src="https://example.test/image">') {
  const f = pageInput(html), id = randomUUID(), owner = { requestId: `req-${id}`, observationId: `obs-${id}`, listingId: `listing-${id}` };
  const page = sign({ ...f.input, ...owner, operationId: `page-${id}`, page: { ...f.input.page, observationId: owner.observationId,
    listingId: owner.listingId, artifactId: `html-${id}`, objectKey: `captured/${id}.html`, producer: { ...f.input.page.producer, operationId: `capture-${id}` } } });
  objects.set(pathFor(page.page.objectKey), f.bytes);
  return { page, textOperationId: `page-text-${id}`, text: CodexTextProvider.describe(codexConfig("html-input")) };
}
async function launchPage(host: string, role: "page-prepare" | "page-text-input") {
  const settings = await config(host), previous = JSON.parse(await readFile(settings, "utf8"));
  await writeFile(settings, JSON.stringify({ cacheRoot: previous.cacheRoot, journalRoot: previous.textLocalRoot,
    r2: previous.r2, r2Credentials: previous.r2Credentials, reviewDatabase: previous.reviewDatabase }), { mode: 0o600 });
  const pageEntry = resolve("dist/acquisition-worker.js"), env = { ...process.env, NODE_EXTRA_CA_CERTS: join(root, "cert.pem"), V3_TEST_S3_PORT: String(port),
    V3_ACQUISITION_LIVE_ENABLED: "true", V3_ACQUISITION_CONFIG: settings };
  const meta = JSON.parse((await exec(process.execPath, [pageEntry, "--list"], { env })).stdout).find((r: { role: string }) => r.role === role);
  expect(meta.compatibility).toBe("page-v1");
  const runtime = join(root, `${host}-runtime.json`);
  await writeFile(runtime, JSON.stringify({ role: meta.role, capability: meta.capability, compatibility: meta.compatibility,
    contractVersion: 1, expectedBuildId: meta.buildId, hostId: host, namespace: "default", address: temporal.address,
    transport: { mode: "local" }, concurrency: 2, shutdownGraceMs: 2000, shutdownForceMs: 5000 }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", resolve("integration/fixtures/s3-loopback.mjs"), pageEntry], {
    env: { ...env, V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: runtime }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); let logs = "";
  child.stdout!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  child.stderr!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  await vi.waitFor(() => { if (child.exitCode !== null) throw Error(logs); expect(logs).toContain('"event":"WORKER_RUNNING"'); }, { timeout: 15000 });
  return child;
}
const startHtml = (plan: ReturnType<typeof htmlPlan>, pageQueue = "v3.page.prepare.v1.page-v1") => temporal.client.workflow.start("PageTextWorkflow", {
  taskQueue: "prepared-text-workflow", workflowId: `html-${randomUUID()}`, args: [{ plan, queues: { page: pageQueue,
    prepare: "v3.page.text-input.v1.page-v1", text: queue, receipts: receiptQueue } }], workflowExecutionTimeout: "1 minute" });
it("two HTML pages publish before downstream starts; independent text prep drives Codex with retained tables", async () => {
  const pages = await launchPage("html-producer", "page-prepare"), plans = [htmlPlan(), htmlPlan('<p>Other ingredients: cellulose</p>')], before = (await executions()).length;
  const handles = await Promise.all(plans.map(p => startHtml(p)));
  try {
    await vi.waitFor(async () => {
      for (const h of handles) expect((await h.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "preparePageText")).toBe(true);
    }, { timeout: 10000 });
    expect(await executions()).toHaveLength(before); await stop(pages);
    const prep = await launchPage("html-input-only", "page-text-input"), model = await launch("html-codex"), receipt = await launchReceipt("html-receipts");
    try {
      const results = await Promise.all(handles.map(h => h.result()));
      results.forEach((r, i) => expect(r).toMatchObject({ status: "registered", registration: { input: { operationId: plans[i]!.textOperationId } } }));
      const completion = JSON.parse(objects.get(pathFor(pageCompletionKey(plans[0]!.page)))!.toString());
      expect(JSON.parse(objects.get(pathFor(completion.tables.objectKey))!.toString())[0].rows[0][0].text).toBe("Other ingredients: water");
      const document = JSON.parse(objects.get(pathFor(completion.document.objectKey))!.toString());
      expect(document.text).toBe("Other ingredients: water"); expect(document.source).toEqual(plans[0]!.page.page);
      expect(await executions()).toHaveLength(before + 2);
      const replacement = await launchPage("html-empty-replacement", "page-prepare"), beforeWrites = writes;
      try { expect(await (await startHtml(plans[0]!)).result()).toEqual(results[0]); expect(writes).toBe(beforeWrites); expect(await executions()).toHaveLength(before + 2); }
      finally { await stop(replacement); }
      const faultQueue = `page-receipt-lost-${randomUUID()}`; let attempts = 0;
      const fault = await Worker.create({ connection: temporal.nativeConnection, taskQueue: faultQueue, activities: {
        prepareHtmlPage: async () => { attempts++; throw ApplicationFailure.nonRetryable("Synthetic lost page response", "TEST.LOST_RESPONSE"); },
      } });
      const faultRunning = fault.run();
      try {
        expect(await (await startHtml(plans[0]!, faultQueue)).result()).toEqual(results[0]);
        expect(await (await startHtml(htmlPlan(), faultQueue)).result()).toMatchObject({ status: "review", code: "PAGE.NOT_DURABLE" });
        expect(attempts).toBe(2); expect(writes).toBe(beforeWrites); expect(await executions()).toHaveLength(before + 2);
      } finally { fault.shutdown(); await faultRunning; }
      await writeFile(join(root, "html-text-history.json"), JSON.stringify(await handles[0]!.fetchHistory(), null, 2));
    } finally { await stop(prep); await stop(model); await stop(receipt); }
  } finally { await stop(pages); }
});
it("empty and over-limit HTML stop before Codex, retaining classified upstream Review", async () => {
  const pages = await launchPage("html-empty", "page-prepare"), prep = await launchPage("html-empty-input", "page-text-input"), before = (await executions()).length;
  try {
    for (const [html, code] of [["<script>ignored</script>", "PROCESSING.PAGE_EMPTY"], ["x".repeat(200001), "PAGE.TEXT_LIMIT"]]) {
      const plan = htmlPlan(html), h = await startHtml(plan);
      expect(await h.result()).toMatchObject({ status: "review", code, operationId: plan.page.operationId });
      expect((await h.fetchHistory()).events?.filter(e => e.activityTaskScheduledEventAttributes).map(e => e.activityTaskScheduledEventAttributes!.activityType!.name)).toEqual(["prepareHtmlPage", "preparePageText"]);
    }
    expect(await executions()).toHaveLength(before);
  } finally { await stop(pages); await stop(prep); }
});
it("HTML publication failure does not reparse or reupload on replacement and cannot trigger Codex", async () => {
  const page = await launchPage("html-upload-failure", "page-prepare"), prep = await launchPage("html-failure-input", "page-text-input");
  const plan = htmlPlan(), before = (await executions()).length, puts = pageDocumentPuts; denyPageDocument = true;
  try {
    expect(await (await startHtml(plan)).result()).toMatchObject({ status: "review", code: "PAGE.HANDOFF_UNVERIFIED" });
    denyPageDocument = false; await stop(page);
    const replacement = await launchPage("html-upload-replacement", "page-prepare");
    try { expect(await (await startHtml(plan)).result()).toMatchObject({ status: "review", code: "PAGE.EXECUTION_UNKNOWN" }); }
    finally { await stop(replacement); }
    expect(pageDocumentPuts).toBe(puts + 1); expect(await executions()).toHaveLength(before);
  } finally { denyPageDocument = false; await stop(page); await stop(prep); }
});

const pdfExtractionQueue = `v3.pdf.text.v1.pdf-v1-${pdfConfigFingerprint.slice(0, 32)}`;
const pdfPrepareQueue = `v3.pdf.text-input.v1.pdf-v1-${pdfConfigFingerprint.slice(0, 32)}`;
const pdfWorkflowQueue = "v3.pdf.text.workflow.v1.pdf-text-v1";
function pdfTextPlan(content = "BT /F1 12 Tf 40 340 Td (Other ingredients: cellulose) Tj ET", pageIndex = 1) {
  const bytes = nutritionPdf(2, content), id = randomUUID(), extraction = pdfInputFor(bytes, "pdf.text", `extract-${id}`, pageIndex);
  extraction.requestId = `req-${id}`; extraction.observationId = `obs-${id}`; extraction.listingId = `listing-${id}`;
  extraction.pdf = { ...extraction.pdf, observationId: extraction.observationId, listingId: extraction.listingId,
    artifactId: `pdf-${id}`, objectKey: `captured/${id}.pdf`, producer: { ...extraction.pdf.producer, operationId: `capture-${id}` } };
  extraction.inputFingerprint = fingerprintPdfInput(extraction); objects.set(pathFor(extraction.pdf.objectKey), bytes);
  return { extraction, textOperationId: `interpret-${id}`, text: CodexTextProvider.describe(codexConfig("pdf-input")) };
}
async function launchPdfText(host: string, role: "pdf-text" | "pdf-text-input" | "pdf-text-workflow", installed = true) {
  const settings = await config(host), data = JSON.parse(await readFile(settings, "utf8")), isWorkflow = role === "pdf-text-workflow";
  await writeFile(settings, JSON.stringify({ cacheRoot: data.cacheRoot, journalRoot: data.textLocalRoot,
    r2: data.r2, r2Credentials: data.r2Credentials, reviewDatabase: data.reviewDatabase,
    ...(role === "pdf-text" ? { pythonExecutable: installed ? resolve("../../packages/v3-pdf/.venv/bin/python") : join(root, "no-python"),
      workRoot: join(root, host, "attempts") } : {}) }), { mode: 0o600 });
  const entry = resolve(isWorkflow ? "dist/product-workflow-worker.js" : "dist/pdf-worker.js"), env = { ...process.env,
    NODE_EXTRA_CA_CERTS: join(root, "cert.pem"), V3_TEST_S3_PORT: String(port), V3_PDF_LIVE_ENABLED: "true", V3_PDF_CONFIG: settings };
  const meta = JSON.parse((await exec(process.execPath, [entry, "--list"], { env })).stdout).find((r: { role: string }) => r.role === role);
  const runtime = join(root, `${host}-runtime.json`);
  await writeFile(runtime, JSON.stringify({ role: meta.role, capability: meta.capability, compatibility: meta.compatibility,
    contractVersion: 1, expectedBuildId: meta.buildId, hostId: host, namespace: "default", address: temporal.address,
    transport: { mode: "local" }, concurrency: isWorkflow ? 2 : 1, shutdownGraceMs: 2000, shutdownForceMs: 5000 }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", resolve("integration/fixtures/s3-loopback.mjs"), entry], {
    env: { ...env, V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: runtime }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); let logs = "";
  child.stdout!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  child.stderr!.on("data", b => { logs = (logs + String(b)).slice(-20000); });
  await vi.waitFor(() => { if (child.exitCode !== null) throw Error(logs); expect(logs).toContain('"event":"WORKER_RUNNING"'); }, { timeout: 15000 });
  return child;
}
const startPdfText = (plan: ReturnType<typeof pdfTextPlan>, extractionQueue = pdfExtractionQueue) => temporal.client.workflow.start("PdfTextWorkflow", {
  taskQueue: pdfWorkflowQueue, workflowId: `pdf-text-${randomUUID()}`, args: [{ plan, queues: { extraction: extractionQueue,
    prepare: pdfPrepareQueue, text: queue, receipts: receiptQueue } }], workflowExecutionTimeout: "1 minute" });
it("PDF pages release the single extraction slot before preparation; compiled consumers retain page provenance and reuse without Python", async () => {
  const parent = await launchPdfText("pdf-parent", "pdf-text-workflow"), extraction = await launchPdfText("pdf-extractor", "pdf-text");
  const plans = [pdfTextPlan(), pdfTextPlan("BT /F1 12 Tf 40 340 Td (Other ingredients: water) Tj ET", 0)], before = (await executions()).length;
  try {
    const handles = await Promise.all(plans.map(p => startPdfText(p)));
    await vi.waitFor(async () => { for (const h of handles)
      expect((await h.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "preparePdfText")).toBe(true);
    }, { timeout: 10000 });
    expect(await readdir(join(root, "pdf-extractor", "attempts"))).toHaveLength(2);
    expect(await executions()).toHaveLength(before); await stop(extraction);
    const prep = await launchPdfText("pdf-preparation-only", "pdf-text-input"), model = await launch("pdf-codex"), receipts = await launchReceipt("pdf-receipts");
    try {
      const outcomes = await Promise.all(handles.map(h => h.result()));
      for (const [i, out] of outcomes.entries()) {
        expect(out).toMatchObject({ status: "registered", registration: { input: { operationId: plans[i]!.textOperationId } } });
        const doc = JSON.parse(objects.get(pathFor(out.registration.input.source.document.objectKey))!.toString());
        expect(doc.source).toEqual(plans[i]!.extraction.pdf); expect(doc.pageIndex).toBe(i === 0 ? 1 : 0);
        expect(doc.text).toBe(i === 0 ? "Other ingredients: cellulose" : "Other ingredients: water");
      }
      expect(await executions()).toHaveLength(before + 2); await stop(prep);
      const replacement = await launchPdfText("pdf-no-engine", "pdf-text", false), otherPrep = await launchPdfText("pdf-empty-prep", "pdf-text-input"), beforeWrites = writes;
      try {
        expect(await (await startPdfText(plans[0]!)).result()).toEqual(outcomes[0]);
        expect(await readdir(join(root, "pdf-no-engine", "attempts"))).toHaveLength(0);
        expect(writes).toBe(beforeWrites); expect(await executions()).toHaveLength(before + 2);
      } finally { await stop(replacement); await stop(otherPrep); }
      await writeFile(join(root, "pdf-direct-text-history.json"), JSON.stringify(await handles[0]!.fetchHistory(), null, 2));
    } finally { await stop(prep); await stop(model); await stop(receipts); }
  } finally { await stop(extraction); await stop(parent); }
});
it("PDF lost extraction response only inspects evidence, while empty and out-of-range pages end before Codex", async () => {
  const parent = await launchPdfText("pdf-fault-parent", "pdf-text-workflow"), extraction = await launchPdfText("pdf-fault-extract", "pdf-text"),
    prep = await launchPdfText("pdf-fault-prep", "pdf-text-input"), model = await launch("pdf-fault-model"), receipts = await launchReceipt("pdf-fault-receipts");
  const faultQueue = `pdf-text-lost-${randomUUID()}`; let calls = 0;
  const fault = await Worker.create({ connection: temporal.nativeConnection, taskQueue: faultQueue, activities: {
    extractPdfPageText: async () => { calls++; throw ApplicationFailure.nonRetryable("Synthetic lost receipt", "TEST.LOST_RESPONSE"); },
  } }); const faultRun = fault.run(), before = (await executions()).length;
  try {
    const plan = pdfTextPlan(), original = await (await startPdfText(plan)).result(); expect(original.status).toBe("registered");
    expect(objects.has(pathFor(pdfCompletionKey(plan.extraction)))).toBe(true);
    const beforeWrites = writes, attempts = await readdir(join(root, "pdf-fault-extract", "attempts"));
    expect(await (await startPdfText(plan, faultQueue)).result()).toEqual(original);
    expect(await (await startPdfText(pdfTextPlan(), faultQueue)).result()).toMatchObject({ status: "review", code: "PDF.NOT_DURABLE" });
    expect(calls).toBe(2); expect(writes).toBe(beforeWrites);
    expect(await readdir(join(root, "pdf-fault-extract", "attempts"))).toEqual(attempts);
    for (const [plan, code] of [[pdfTextPlan(""), "PDF.TEXT_EMPTY"], [pdfTextPlan(undefined, 4), "PDF.PAGE_RANGE"]] as const) {
      const h = await startPdfText(plan);
      expect(await h.result()).toMatchObject({ status: "review", operationId: plan.extraction.operationId, code });
      expect((await h.fetchHistory()).events?.filter(e => e.activityTaskScheduledEventAttributes).map(e => e.activityTaskScheduledEventAttributes!.activityType!.name))
        .toEqual(["extractPdfPageText", "preparePdfText"]);
    }
    expect(await executions()).toHaveLength(before + 1);
  } finally { fault.shutdown(); await faultRun; await Promise.all([parent, extraction, prep, model, receipts].map(stop)); }
});
it("PDF workflow rejects foreign or malformed preparation receipts and cancellation never launches recovery", async () => {
  const parent = await launchPdfText("pdf-protocol-parent", "pdf-text-workflow"), fakeQueue = `pdf-protocol-${randomUUID()}`;
  let extractionCalls = 0, prepareCalls = 0, mode = "malformed";
  const fake = await Worker.create({ connection: temporal.nativeConnection, taskQueue: fakeQueue, activities: {
    extractPdfPageText: async () => { extractionCalls++; throw ApplicationFailure.nonRetryable("No evidence", "TEST.LOST_RESPONSE"); },
    preparePdfText: async () => { prepareCalls++; return mode === "malformed" ? { status: "prepared" } : {
      status: "review", operationId: "foreign", reviewId: "foreign-review", evidenceKey: "foreign/review.json", code: "PDF.TEXT_EMPTY", automaticRetry: false,
    }; },
  } }); const run = fake.run(), before = (await executions()).length;
  const start = (extraction: string) => temporal.client.workflow.start("PdfTextWorkflow", { taskQueue: pdfWorkflowQueue,
    workflowId: `pdf-protocol-${randomUUID()}`, args: [{ plan: pdfTextPlan(), queues: { extraction, prepare: fakeQueue, text: queue, receipts: receiptQueue } }],
    workflowExecutionTimeout: "30 seconds" });
  try {
    for (const value of ["malformed", "foreign"]) {
      mode = value; const h = await start(fakeQueue); await expect(h.result()).rejects.toThrow();
      expect((await h.fetchHistory()).events?.some(e => e.workflowExecutionFailedEventAttributes)).toBe(true);
    }
    const cancelled = await start(`no-pdf-consumer-${randomUUID()}`);
    await vi.waitFor(async () => expect((await cancelled.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes)).toBe(true));
    await cancelled.cancel(); await expect(cancelled.result()).rejects.toThrow();
    expect((await cancelled.fetchHistory()).events?.some(e => e.workflowExecutionCanceledEventAttributes)).toBe(true);
    expect(prepareCalls).toBe(2); expect(extractionCalls).toBe(2); expect(await executions()).toHaveLength(before);
  } finally { fake.shutdown(); await run; await stop(parent); }
});
