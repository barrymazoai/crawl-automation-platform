import { randomUUID } from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import type { CollectionWorkflowInput } from "@crawl-automation/v3-contracts";
import { startTestDatabase } from "../integration/postgres.js";
import { PostgresBrands } from "../src/storage/postgres-brands.js";
import { PostgresSubmissions } from "../src/storage/postgres-submissions.js";
import { PostgresDelivery } from "../src/storage/postgres-delivery.js";
import { TemporalGateway } from "../src/delivery/temporal-gateway.js";
import { DeliveryCoordinator } from "../src/delivery/coordinator.js";
import { DeliveryReviewer } from "../src/delivery/reviewer.js";
import { inputHash, workflowInput } from "../src/delivery/identity.js";

const exec = promisify(execFile);
let env: TestWorkflowEnvironment;
let db: Awaited<ReturnType<typeof startTestDatabase>>;
let submissions: PostgresSubmissions; let journal: PostgresDelivery; let gateway: TemporalGateway;
let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
const children: ChildProcess[] = []; const ownedIds: string[] = [];
const calls = new Map<string, number>(); const reports: unknown[] = [];
beforeAll(async () => {
  db = await startTestDatabase({ tcp: true }); submissions = new PostgresSubmissions(db.pool); journal = new PostgresDelivery(db.pool);
  env = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false,
    executable: process.env.V3_TEST_TEMPORAL_CLI ? { type: "existing-path", path: process.env.V3_TEST_TEMPORAL_CLI } : { type: "cached-download", version: "v1.8.3" },
  } });
  gateway = new TemporalGateway(env.client, { clusterId: "recovery-test", namespace: "default", taskQueue: `recovery-test-${randomUUID()}`, workflowType: "DeliveryAcceptanceProbe" });
  bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("workflows.ts", import.meta.url)) });
});
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  try { await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 6000, interval: 25 }); }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}
afterAll(async () => {
  await Promise.all(children.map(child => stop(child)));
  try {
    for (const id of ownedIds) {
      const handle = env.client.workflow.getHandle(id);
      if ((await handle.describe().catch(() => null))?.status.name === "RUNNING") await handle.terminate("End owned recovery fixture");
    }
    await writeFile(join(db.root, "recovery-proof.json"), JSON.stringify(reports, null, 2));
    console.log("RECOVERY_PROOF", join(db.root, "recovery-proof.json"), JSON.stringify(reports));
  } finally { await env?.teardown(); await db?.close(); }
});
async function fixture() {
  const brands = new PostgresBrands(db.pool);
  const b = (await brands.create({ name: `Recovery ${randomUUID()}`, note: "" }, randomUUID())).value;
  const s = (await brands.createSource(b.id, { channel: "dtc", region: "US", url: "https://synthetic.example/recovery" }, randomUUID())).value;
  await brands.toggleSource(b.id, s.id, { enabled: true, revision: 1 }, randomUUID());
  const submission = (await submissions.accept(b.id, s.id, { sourceRevision: 2 }, randomUUID())).value;
  ownedIds.push(submission.workflowId); return submission;
}
const guard = async (id: string) => (await db.pool.query("SELECT request_id FROM source_submission_guard WHERE request_id=$1", [id])).rowCount;
async function worker() {
  return Worker.create({ connection: env.nativeConnection, namespace: "default", taskQueue: gateway.target.taskQueue, workflowBundle: bundle,
    shutdownGraceTime: "1 second", shutdownForceTime: "3 seconds", activities: {
      echoLocal: async (input: CollectionWorkflowInput) => { calls.set(input.requestId, (calls.get(input.requestId) ?? 0) + 1);
        return { requestId: input.requestId, hostname: "isolated-recovery", platform: process.platform, pid: process.pid }; },
    } });
}
async function ready(id: string) {
  await vi.waitFor(async () => expect(await env.client.workflow.getHandle(id).query("deliveryProbeReady")).toBe(true), { timeout: 10_000, interval: 50 });
}
async function child(script: string, profile: string) {
  const args = ["--import", "tsx", script];
  if (script.includes("recovery-process")) args.push(profile);
  const p = spawn(process.execPath, args, { cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, V3_DATABASE_URL: db.databaseUrl!, V3_DELIVERY_ENABLED: "true", V3_DELIVERY_CONFIG: profile }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(p); let logs = "";
  p.stdout!.on("data", data => { logs = (logs + String(data)).slice(-30_000); });
  p.stderr!.on("data", data => { logs = (logs + String(data)).slice(-30_000); });
  return { process: p, logs: () => logs };
}
async function waitEvent(c: Awaited<ReturnType<typeof child>>, event: string) {
  await vi.waitFor(() => { if (c.process.exitCode !== null || c.process.signalCode !== null) throw new Error(c.logs()); expect(c.logs()).toContain(`"event":"${event}"`); }, { timeout: 10_000 });
}
async function runtimeProfile() {
  const path = join(db.root, `runtime-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify({ address: env.address, target: gateway.target, transport: { mode: "local" },
    pauseFile: join(db.root, "unused-pause"), batchSize: 20, concurrency: 2, intervalMs: 100, shutdownMs: 3000 }), { mode: 0o600 });
  return path;
}
const stages = ["before_intent", "after_intent", "after_start", "before_terminal_record", "after_terminal_record"];
describe("real OS interruption at durable handoff boundaries", () => {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) for (const stage of stages) {
    it(`${signal} at ${stage}: restarted runtime does not duplicate execution`, async () => {
      const s = await fixture(); const path = join(db.root, `${s.requestId}.json`);
      await writeFile(path, JSON.stringify({ requestId: s.requestId, address: env.address, target: gateway.target, stage }), { mode: 0o600 });
      const w = await worker();
      await w.runUntil(async () => {
        const first = await child("temporal-tests/recovery-process.ts", path);
        const handle = env.client.workflow.getHandle(s.workflowId);
        if (stage.includes("terminal")) { await ready(s.workflowId); await handle.signal("deliveryProbeAction", "complete"); await handle.result(); }
        await waitEvent(first, "RECOVERY_CHECKPOINT");
        const before = await journal.get(s.requestId);
        expect(before === null).toBe(stage === "before_intent");
        await stop(first.process, signal); expect(first.process.signalCode).toBe(signal);
        const profile = await runtimeProfile();
        const restart = await child("src/delivery-server.ts", profile); await waitEvent(restart, "DELIVERY_READY");
        try {
          if (stage === "after_intent") {
            await vi.waitFor(async () => expect((await journal.get(s.requestId))?.lastIssue).toBe("NOT_FOUND"));
            expect(calls.get(s.requestId) ?? 0).toBe(0); expect(await guard(s.requestId)).toBe(1);
            await expect(handle.describe()).rejects.toThrow();
          } else {
            if (!stage.includes("terminal")) { await ready(s.workflowId); await handle.signal("deliveryProbeAction", "complete"); await handle.result(); }
            await vi.waitFor(async () => expect((await journal.get(s.requestId))?.state).toBe("CLOSED"), { timeout: 10_000 });
            expect(calls.get(s.requestId)).toBe(1); expect(await guard(s.requestId)).toBe(0);
            expect((await handle.fetchHistory()).events?.filter(e => e.workflowExecutionStartedEventAttributes).length).toBe(1);
          }
          const receipt = await journal.get(s.requestId);
          // Operator path must not update checkedAt, create an intent, clear guard or trigger Start.
          const result = await exec(process.execPath, ["--import", "tsx", "src/review-delivery.ts", s.requestId], {
            cwd: fileURLToPath(new URL("../", import.meta.url)), env: { ...process.env, V3_DATABASE_URL: db.databaseUrl!, V3_REVIEW_CONFIG: profile },
          });
          expect(JSON.parse(result.stdout).mutatesState).toBe(false);
          if (receipt?.state === "CLOSED") expect(await journal.get(s.requestId)).toEqual(receipt);
          reports.push({ signal, stage, requestId: s.requestId, killedPid: first.process.pid, restartPid: restart.process.pid,
            calls: calls.get(s.requestId) ?? 0, state: receipt?.state, issue: receipt?.lastIssue, guard: await guard(s.requestId) });
        } finally { await stop(restart.process); }
      });
    });
  }
});

describe("cross-run ancestry is conservatively isolated", () => {
  for (const mode of ["continue", "retry", "reset"] as const) it(`retains guard for ${mode}, including before any run was recorded`, async () => {
    const s = await fixture(); const coordinator = new DeliveryCoordinator(submissions, journal, gateway);
    const input = workflowInput(s);
    await journal.begin(s.requestId, gateway.target, inputHash(input));
    // Retry policy exists ONLY in this negative fixture, never production gateway.
    await env.client.workflow.start(gateway.target.workflowType, { workflowId: s.workflowId, taskQueue: gateway.target.taskQueue, args: [input],
      workflowExecutionTimeout: "1 minute", ...(mode === "retry" ? { retry: { maximumAttempts: 2, initialInterval: "100 milliseconds" } } : {}) });
    const root = await env.client.workflow.getHandle(s.workflowId).describe();
    const w = await worker();
    await w.runUntil(async () => {
      await ready(s.workflowId);
      if (mode === "reset") {
        const history = await env.client.workflow.getHandle(s.workflowId).fetchHistory();
        const completed = history.events?.find(e => e.workflowTaskCompletedEventAttributes);
        if (!completed?.eventId) throw new Error("No reset point in owned test Workflow");
        await env.client.workflowService.resetWorkflowExecution({ namespace: "default", workflowExecution: { workflowId: s.workflowId, runId: root.runId },
          workflowTaskFinishEventId: completed.eventId, requestId: randomUUID(), reason: "Owned isolation negative test", resetReapplyType: 2 });
      } else await env.client.workflow.getHandle(s.workflowId).signal("deliveryProbeAction", mode === "retry" ? "fail-once" : "continue");
      await vi.waitFor(async () => expect((await env.client.workflow.getHandle(s.workflowId).describe()).runId).not.toBe(root.runId), { timeout: 10_000 });
      await ready(s.workflowId);
      const changed = await coordinator.reconcile(s.requestId);
      expect(changed.lastIssue).toBe("CHAIN_CONTINUED"); expect(changed.runId).toBeNull();
      await env.client.workflow.getHandle(s.workflowId).signal("deliveryProbeAction", "complete");
      await env.client.workflow.getHandle(s.workflowId).result();
      const final = await coordinator.reconcile(s.requestId);
      expect(final.state).not.toBe("CLOSED"); expect(final.lastIssue).toBe("CHAIN_CONTINUED"); expect(await guard(s.requestId)).toBe(1);
      const reviewer = new DeliveryReviewer(submissions, journal, { target: gateway.target, inspect: s => gateway.inspect(s) });
      expect(await reviewer.inspect(s.requestId)).toMatchObject({ decision: "HOLD", issue: "CHAIN_CONTINUED", mutatesState: false });
      expect(await journal.get(s.requestId)).toEqual(final);
      reports.push({ mode, requestId: s.requestId, originalRun: root.runId, latestRun: (await env.client.workflow.getHandle(s.workflowId).describe()).runId, state: final.state, issue: final.lastIssue, guard: 1 });
    });
  });
});
