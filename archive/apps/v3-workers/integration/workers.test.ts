import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { RoleRegistry, parseWorkerConfig, type RoleDefinition } from "@crawl-automation/v3-worker-runtime";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../.local/test-dist/worker.js", import.meta.url));
const businessEntry = fileURLToPath(new URL("../dist/worker.js", import.meta.url));
let env: TestWorkflowEnvironment; let root: string;
let metadata: Array<Omit<RoleDefinition, "prepare">>;
const session = `run-${randomUUID()}`;
const children: Array<{ child: ChildProcess; logs(): string }> = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "v3-worker-runtime-"));
  metadata = JSON.parse((await exec(process.execPath, [entry, "--list"])).stdout);
  env = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false,
    executable: process.env.V3_TEST_TEMPORAL_CLI ? { type: "existing-path", path: process.env.V3_TEST_TEMPORAL_CLI } : { type: "cached-download", version: "v1.8.3" },
  } });
});
async function stop(process: { child: ChildProcess }) {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill("SIGTERM");
  try { await vi.waitFor(() => expect(process.child.exitCode).toBe(0), { timeout: 12_000, interval: 50 }); }
  finally { if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGKILL"); }
}
afterAll(async () => {
  await Promise.allSettled(children.map(stop));
  if (env) await env.teardown();
  console.log(`Stopped isolated Worker runtime test processes and Temporal. Evidence: ${root}`);
});
function configuration(role: string, extra: Record<string, unknown> = {}) {
  const d = metadata.find(d => d.role === role)!;
  return { role, capability: d.capability, contractVersion: d.contractVersion, compatibility: d.compatibility,
    expectedBuildId: d.buildId, hostId: "local-test-host", namespace: "default", address: env.address,
    transport: { mode: "local" }, testSession: session, concurrency: d.kind === "workflow" ? 2 : 1, shutdownGraceMs: 5000, shutdownForceMs: 8000, ...extra };
}
const queue = (role: string) => {
  const d = metadata.find(d => d.role === role)!;
  const registry = new RoleRegistry("test", [{ ...d, prepare: async () => { throw new Error("metadata only"); } }]);
  return registry.select(parseWorkerConfig(configuration(role))).taskQueue;
};
async function launch(role: string, extra: Record<string, unknown> = {}) {
  const path = join(root, `${role}-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(configuration(role, extra)), { mode: 0o600 });
  const child = spawn(process.execPath, [entry], { env: { ...process.env, V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: path }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout!.on("data", data => { logs = (logs + String(data)).slice(-40_000); });
  child.stderr!.on("data", data => { logs = (logs + String(data)).slice(-40_000); });
  const owned = { child, logs: () => logs }; children.push(owned);
  await vi.waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker exited during startup: ${logs}`);
    expect(logs).toContain('"event":"WORKER_RUNNING"');
  }, { timeout: 15_000, interval: 50 });
  return owned;
}
async function workflow(delayMs = 0, fail = false) {
  const requestId = randomUUID();
  const handle = await env.client.workflow.start("RuntimeIsolationProbe", { taskQueue: queue("fixture-workflow"),
    workflowId: `runtime-probe-${requestId}`, args: [{ requestId, queue: queue("fixture-echo"), delayMs, fail }], workflowExecutionTimeout: "1 minute" });
  return { handle, requestId };
}

describe("independent compiled Worker roles on real local Temporal", () => {
  it("does not package test roles into the business entry and rejects wrong builds before polling", async () => {
    expect(JSON.parse((await exec(process.execPath, [businessEntry, "--list"])).stdout)).toEqual([]);
    expect(await readFile(businessEntry, "utf8")).not.toContain("RuntimeIsolationProbe");
    const profile = join(root, "wrong-build.json");
    await writeFile(profile, JSON.stringify(configuration("fixture-echo", { expectedBuildId: "0".repeat(64) })), { mode: 0o600 });
    await expect(exec(process.execPath, [entry], { env: { ...process.env, V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: profile } })).rejects.toMatchObject({ code: 1 });
    await writeFile(profile, JSON.stringify(configuration("fixture-echo")), { mode: 0o600 });
    await expect(exec(process.execPath, [businessEntry], { env: { ...process.env, V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: profile } })).rejects.toMatchObject({ code: 1 });
  });
  it("keeps workflow and activity processes independent, drains in-flight work and leaves new work queued", async () => {
    const orchestration = await launch("fixture-workflow");
    const first = await workflow(800);
    // The orchestration Worker cannot execute the Activity itself.
    await vi.waitFor(async () => {
      const history = await first.handle.fetchHistory();
      expect(history.events?.some(e => e.activityTaskScheduledEventAttributes)).toBe(true);
      expect(history.events?.some(e => e.activityTaskStartedEventAttributes)).toBe(false);
    });
    const atomic = await launch("fixture-echo");
    await vi.waitFor(() => expect(atomic.logs()).toContain(`"requestId":"${first.requestId}"`));
    atomic.child.kill("SIGTERM");
    await vi.waitFor(() => expect(atomic.logs()).toContain('"event":"WORKER_DRAINING"'));
    const second = await workflow();
    const result = await first.handle.result();
    expect(result).toMatchObject({ requestId: first.requestId, pid: atomic.child.pid, hostId: "local-test-host" });
    await vi.waitFor(() => expect(atomic.child.exitCode).toBe(0), { timeout: 10_000 });
    const finished = atomic.logs().indexOf('"event":"FIXTURE_ACTIVITY_FINISHED"');
    const disposed = atomic.logs().indexOf('"event":"FIXTURE_MODULE_DISPOSED"');
    expect(disposed).toBeGreaterThan(finished); expect(finished).toBeGreaterThan(-1);
    await vi.waitFor(async () => expect((await second.handle.fetchHistory()).events?.some(e => e.activityTaskScheduledEventAttributes)).toBe(true));
    expect((await second.handle.fetchHistory()).events?.some(e => e.activityTaskStartedEventAttributes)).toBe(false);
    expect(orchestration.child.exitCode).toBeNull();
    const replacement = await launch("fixture-echo");
    expect(await second.handle.result()).toMatchObject({ requestId: second.requestId, pid: replacement.child.pid });
    const history = await first.handle.fetchHistory();
    const wfIdentity = history.events?.find(e => e.workflowTaskStartedEventAttributes)?.workflowTaskStartedEventAttributes?.identity;
    const activityIdentity = history.events?.find(e => e.activityTaskStartedEventAttributes)?.activityTaskStartedEventAttributes?.identity;
    expect(wfIdentity).toContain("/fixture-workflow/"); expect(activityIdentity).toContain("/fixture-echo/"); expect(wfIdentity).not.toBe(activityIdentity);
    const proof = { requestId: first.requestId, workflowId: first.handle.workflowId, workflowPid: orchestration.child.pid,
      atomicPid: atomic.child.pid, replacementPid: replacement.child.pid, wfIdentity, activityIdentity, result,
      activityDisposedAfterCompletion: true, atomicExit: atomic.child.exitCode };
    await writeFile(join(root, "worker-runtime-proof.json"), JSON.stringify(proof, null, 2));
    console.log("WORKER_RUNTIME_PROOF", JSON.stringify(proof));
    await stop(replacement); await stop(orchestration);
  });
  it("does not retry a failed synthetic operation and forcibly exits a stuck Activity without disposing it", async () => {
    const orchestration = await launch("fixture-workflow");
    const atomic = await launch("fixture-echo", { shutdownGraceMs: 100, shutdownForceMs: 1000 });
    const failed = await workflow(0, true);
    await expect(failed.handle.result()).rejects.toThrow();
    expect(atomic.logs().split(`"requestId":"${failed.requestId}"`).length - 1).toBe(1);
    const stuck = await workflow(20_000);
    await vi.waitFor(() => expect(atomic.logs()).toContain(`"requestId":"${stuck.requestId}"`));
    atomic.child.kill("SIGTERM");
    await vi.waitFor(() => expect(atomic.child.exitCode).toBe(1), { timeout: 6000 });
    expect(atomic.logs()).not.toContain('"event":"FIXTURE_MODULE_DISPOSED"');
    expect(atomic.logs()).not.toContain('"event":"WORKER_STOPPED"');
    // Only this test-owned Workflow is terminated; this is not a production recovery operation.
    await stuck.handle.terminate("End owned synthetic timeout fixture");
    await stop(orchestration);
  });
});
