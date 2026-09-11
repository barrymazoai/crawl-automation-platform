import { createServer, type Server } from "node:http";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { fixture } from "../../v3-results/src/testing.fixture.js";
import { fingerprintOcrInput, type OcrInput } from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/v3-artifacts";
import { MultipartOcr } from "../src/http.js";
import { png } from "../src/testing.fixture.js";
import { FixtureObjects } from "./fixtures/store.js";

let env: TestWorkflowEnvironment, server: Server, root: string, endpoint: string, buildId: string;
let workflow: Worker, running: Promise<void>;
const session = `ocr-${randomUUID()}`, queue = `v3.test.${session}.ocr.file.v1.fixture-v1`, wfQueue = `v3.test.${session}.workflow`;
const children: ChildProcess[] = []; let requests = 0, mode = "ok";
let objects: FixtureObjects;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "v3-ocr-temporal-")); objects = new FixtureObjects(join(root, "objects"));
  server = createServer((req, res) => { requests++; req.resume(); req.on("end", () => {
    if (mode === "hang") return;
    res.setHeader("Content-Type", "application/json");
    if (mode === "fail") { res.statusCode = 500; res.end("{}"); } else res.end(JSON.stringify({ text: "mock recognized text, not a real OCR service", lines: [] }));
  }); });
  await new Promise<void>((r, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", r); });
  const address = server.address(); if (!address || typeof address === "string") throw Error();
  endpoint = `http://127.0.0.1:${address.port}/ocr`;
  await writeFile(join(root, "fixture.json"), JSON.stringify({ root, endpoint }), { mode: 0o600 });
  const metadata = JSON.parse((await promisify(execFile)(process.execPath, [resolve(".local/test-dist/worker.js"), "--list"])).stdout);
  buildId = metadata[0].buildId;
  env = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false,
    executable: process.env.V3_TEST_TEMPORAL_CLI ? { type: "existing-path", path: process.env.V3_TEST_TEMPORAL_CLI } : { type: "cached-download", version: "v1.8.3" } } });
  workflow = await Worker.create({ connection: env.nativeConnection, taskQueue: wfQueue, workflowBundle: { codePath: resolve(".local/test-dist/workflows.cjs") } });
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
  await env?.teardown();
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  console.log(`OCR isolated evidence: ${root}; all owned services stopped`);
});
async function launch(hostId: string) {
  const path = join(root, `${hostId}.json`);
  await writeFile(path, JSON.stringify({ role: "ocr-file", capability: "ocr.file", contractVersion: 1, compatibility: "fixture-v1", expectedBuildId: buildId,
    hostId, namespace: "default", address: env.address, transport: { mode: "local" }, testSession: session, concurrency: 1, shutdownGraceMs: 2000, shutdownForceMs: 5000 }), { mode: 0o600 });
  const child = spawn(process.execPath, [resolve(".local/test-dist/worker.js")], { env: { ...process.env, V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: path,
    V3_OCR_FIXTURE_CONFIG: join(root, "fixture.json") }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); let logs = "";
  child.stdout!.on("data", c => { logs = (logs + String(c)).slice(-40000); });
  child.stderr!.on("data", c => { logs = (logs + String(c)).slice(-40000); });
  await vi.waitFor(() => { if (child.exitCode !== null) throw Error(logs); expect(logs).toContain('"event":"WORKER_RUNNING"'); }, { timeout: 15000 });
  return child;
}
async function task(): Promise<OcrInput> {
  const input = fixture().input, provider = new MultipartOcr({ endpoint, provider: "fixture-service/1", allowLoopbackHttp: true, timeoutMs: 500 });
  Object.assign(input, provider.supported); input.file.sha256 = sha256(png); input.file.byteSize = png.length;
  input.inputFingerprint = fingerprintOcrInput(input, x => sha256(Buffer.from(x)));
  await objects.create(input.file.objectKey, png, "image/png", new AbortController().signal); return input;
}
const start = (input: OcrInput, wait = false, twice = false) => env.client.workflow.start("OcrIsolationProbe", {
  taskQueue: wfQueue, workflowId: `ocr-probe-${randomUUID()}`, args: [{ task: input, queue, wait, twice }], workflowExecutionTimeout: "1 minute" });

it("only separate OCR process can pick up task; completed A waiting downstream does not block B", async () => {
  const a = await start(await task(), true);
  await vi.waitFor(async () => expect((await a.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes)).toBe(true));
  expect((await a.fetchHistory()).events?.some(e => e.activityTaskStartedEventAttributes)).toBe(false);
  const child = await launch("ocr-node-a");
  await vi.waitFor(async () => expect((await a.fetchHistory()).events?.some(e => e.activityTaskCompletedEventAttributes)).toBe(true));
  const b = await start(await task()); expect(await b.result()).toMatchObject({ status: "registered" });
  expect((await a.describe()).status.name).toBe("RUNNING");
  const history = await b.fetchHistory();
  expect(history.events?.find(e => e.activityTaskScheduledEventAttributes)?.activityTaskScheduledEventAttributes?.retryPolicy?.maximumAttempts).toBe(1);
  expect(history.events?.find(e => e.activityTaskStartedEventAttributes)?.activityTaskStartedEventAttributes?.identity).toContain("ocr-node-a/ocr-file/");
  await a.signal("release"); await a.result();
  await writeFile(join(root, "isolation-proof.json"), JSON.stringify({ parentPid: process.pid, ocrPid: child.pid, workflowA: a.workflowId, workflowB: b.workflowId, requests, maxAttempts: 1 }));
  await stop(child);
});
it("two independent nodes race one operation but HTTP service sees one call; restart reuses registered evidence", async () => {
  const a = await launch("ocr-node-b"), b = await launch("ocr-node-c"), input = await task(), before = requests;
  const runs = await Promise.all([start(input), start(input)]);
  const results = await Promise.all(runs.map(h => h.result()));
  expect(results.some(r => r.status === "registered")).toBe(true); expect(requests - before).toBe(1);
  await stop(a); await stop(b);
  const replacement = await launch("ocr-node-d");
  expect(await (await start(input, false, true)).result()).toMatchObject({ status: "registered" });
  expect(requests - before).toBe(1); await stop(replacement);
});
it("HTTP timeout is passive Review and explicit duplicate Activity does not re-call", async () => {
  const child = await launch("ocr-node-e"), before = requests; mode = "hang";
  try {
    const run = await start(await task(), false, true);
    expect(await run.result()).toMatchObject({ status: "review", code: "OCR.TIMEOUT", automaticRetry: false });
    expect(requests - before).toBe(1);
    const events = (await run.fetchHistory()).events!;
    expect(events.filter(e => e.activityTaskScheduledEventAttributes)).toHaveLength(2);
    expect(events.filter(e => e.activityTaskScheduledEventAttributes).every(e => e.activityTaskScheduledEventAttributes?.retryPolicy?.maximumAttempts === 1)).toBe(true);
  } finally { mode = "ok"; await stop(child); }
});
