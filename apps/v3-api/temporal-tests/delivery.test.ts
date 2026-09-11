import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { Client, Connection } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, NativeConnection, bundleWorkflowCode } from "@temporalio/worker";
import { CollectionSubmission, type CollectionWorkflowInput } from "@crawl-automation/v3-contracts";
import { startTestDatabase } from "../integration/postgres.js";
import { createApp } from "../src/http/app.js";
import { PostgresBrands } from "../src/storage/postgres-brands.js";
import { PostgresSubmissions } from "../src/storage/postgres-submissions.js";
import { PostgresDelivery } from "../src/storage/postgres-delivery.js";
import { DeliveryCoordinator } from "../src/delivery/coordinator.js";
import { workflowInput } from "../src/delivery/identity.js";
import { TemporalGateway } from "../src/delivery/temporal-gateway.js";
import { DeliveryRunner } from "../src/delivery/runner.js";
import { PostgresDeliveryScan } from "../src/storage/postgres-delivery-scan.js";
import type { LocalProof } from "./workflows.js";

const projectId = "8ed88b1f-498d-4caa-8877-21ff7b93dbae";
const cloudOptIn = process.env.V3_DELIVERY_CLOUD_PROBE;
if (cloudOptIn && cloudOptIn !== projectId) throw new Error("Invalid explicit cloud probe project");
let env: TestWorkflowEnvironment | undefined;
let client: Client;
let connection: Connection | undefined;
let native: NativeConnection;
let db: Awaited<ReturnType<typeof startTestDatabase>>;
let brands: PostgresBrands;
let submissions: PostgresSubmissions;
let journal: PostgresDelivery;
let gateway: TemporalGateway;
let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
let server: ReturnType<typeof serve> | undefined;
let base: string;
let uiUrl = "";
let address: string;
const token = "isolated-delivery-http-proof-not-production-secret";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const workerIdentity = `v3-delivery-proof@${hostname()}:${process.pid}`;
const ownedIds: string[] = [];
let activityCalls = 0;

beforeAll(async () => {
  db = await startTestDatabase({ tcp: true });
  brands = new PostgresBrands(db.pool);
  submissions = new PostgresSubmissions(db.pool);
  journal = new PostgresDelivery(db.pool);
  if (cloudOptIn) {
    const root = new URL("../../../infra/temporal/", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("deployment.json", root), "utf8"));
    if (manifest.projectId !== projectId || manifest.namespace !== "crawler-v3-test") throw new Error("Wrong integration target");
    address = manifest.address;
    uiUrl = manifest.uiUrl;
    const tls = {
      serverNameOverride: manifest.tlsServerName,
      serverRootCACertificate: await readFile(new URL(".local/ca.pem", root)),
      clientCertPair: { crt: await readFile(new URL(".local/mac-worker.pem", root)), key: await readFile(new URL(".local/mac-worker-key.pem", root)) },
    };
    connection = await Connection.connect({ address, tls, connectTimeout: "20 seconds" });
    native = await NativeConnection.connect({ address, tls });
    client = new Client({ connection, namespace: manifest.namespace });
  } else {
    env = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false,
      executable: process.env.V3_TEST_TEMPORAL_CLI ? { type: "existing-path", path: process.env.V3_TEST_TEMPORAL_CLI } : { type: "cached-download", version: "v1.8.3" },
    } });
    client = env.client; native = env.nativeConnection; address = env.address;
  }
  gateway = new TemporalGateway(client, { clusterId: cloudOptIn ? projectId : "isolated-local-temporal", namespace: client.workflow.options.namespace,
    taskQueue: `v3-delivery-probe-${randomUUID()}`, workflowType: "DeliveryAcceptanceProbe" });
  bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("workflows.ts", import.meta.url)) });
  const app = createApp(brands, token, { submissions, delivery: journal, acceptSubmissions: true });
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => { server!.once("listening", resolve); server!.once("error", reject); });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Expected local HTTP listener");
  base = `http://127.0.0.1:${bound.port}`;
});
afterAll(async () => {
  try {
    // Only our explicitly created, isolated test Workflow IDs; no unrelated jobs.
    for (const id of ownedIds) {
      const handle = client.workflow.getHandle(id);
      const run = await handle.describe().catch(() => null);
      if (run?.status.name === "RUNNING") await handle.terminate("Isolated delivery probe cleanup");
    }
  } finally {
    if (server) {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    if (env) await env.teardown();
    else { await native?.close(); await connection?.close(); }
    await db?.close();
  }
});
async function accepted() {
  const brand = (await brands.create({ name: `Temporal intake probe ${randomUUID()}`, note: "Synthetic integration fixture" }, randomUUID())).value;
  const source = (await brands.createSource(brand.id, { channel: "dtc", region: "US", url: "https://synthetic.example/products" }, randomUUID())).value;
  await brands.toggleSource(brand.id, source.id, { enabled: true, revision: 1 }, randomUUID());
  const path = `/api/v3/brands/${brand.id}/sources/${source.id}/submissions`;
  const key = randomUUID();
  const response = await fetch(base + path, { method: "POST", headers: { ...headers, "Idempotency-Key": key }, body: JSON.stringify({ sourceRevision: 2 }) });
  expect(response.status).toBe(202);
  const submission = CollectionSubmission.parse(await response.json());
  ownedIds.push(submission.workflowId);
  return { submission, brand, source, path };
}
async function worker() {
  return Worker.create({ connection: native, namespace: gateway.target.namespace, taskQueue: gateway.target.taskQueue,
    workflowBundle: bundle, identity: workerIdentity, shutdownGraceTime: "1 second", shutdownForceTime: "5 seconds",
    activities: { echoLocal: async (input: CollectionWorkflowInput): Promise<LocalProof> => {
      activityCalls++;
      return { requestId: input.requestId, hostname: hostname(), platform: process.platform, pid: process.pid };
    } },
  });
}
async function ready(id: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await client.workflow.getHandle(id).query<boolean>("deliveryProbeReady").catch(() => false)) return;
    await delay(100);
  }
  throw new Error("Local Worker did not reach probe wait state");
}

describe("actual HTTP → PostgreSQL → Temporal → local Worker → terminal readback", () => {
  it.skipIf(!!cloudOptIn)("independent process can pause, resume, stop and restart against the same durable journal", async () => {
    const f = await accepted();
    const pauseFile = join(db.root, "delivery.pause");
    const resumedFile = join(db.root, "delivery.pause.saved");
    const configFile = join(db.root, "delivery-profile.json");
    await writeFile(pauseFile, "pause", { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({ target: gateway.target, address, transport: { mode: "local" }, pauseFile,
      batchSize: 2, concurrency: 2, intervalMs: 100, shutdownMs: 5000 }), { mode: 0o600 });
    const children: ChildProcess[] = [];
    const launch = async () => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/delivery-server.ts"], {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: { ...process.env, V3_DATABASE_URL: db.databaseUrl!, V3_DELIVERY_ENABLED: "true", V3_DELIVERY_CONFIG: configFile },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      let output = ""; child.stdout!.on("data", data => { output += String(data); });
      child.stderr!.on("data", data => { output += String(data); });
      await vi.waitFor(() => {
        if (child.exitCode !== null) throw new Error(`Runner exited before ready: ${output}`);
        expect(output).toContain('"event":"DELIVERY_READY"');
      }, { timeout: 10_000, interval: 50 });
      return { child, output: () => output };
    };
    const stop = async (child: ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      try { await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 8000, interval: 50 }); }
      finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    };
    try {
      const first = await launch();
      await delay(250); expect(await journal.get(f.submission.requestId)).toBeNull();
      const w = await worker();
      await w.runUntil(async () => {
        const { rename } = await import("node:fs/promises");
        await rename(pauseFile, resumedFile); // Preserve, don't delete the pause evidence.
        await ready(f.submission.workflowId);
        await client.workflow.getHandle(f.submission.workflowId).signal("deliveryProbeAction", "complete");
        await client.workflow.getHandle(f.submission.workflowId).result();
        await vi.waitFor(async () => expect((await journal.get(f.submission.requestId))?.state).toBe("CLOSED"), { timeout: 10_000, interval: 50 });
      });
      const closed = await journal.get(f.submission.requestId);
      await stop(first.child);
      expect(first.output()).toContain('"event":"DELIVERY_STOPPED"');
      const second = await launch(); await delay(250); await stop(second.child);
      expect(await journal.get(f.submission.requestId)).toEqual(closed);
      expect(second.child.pid).not.toBe(first.child.pid);
      expect(await submissions.active(f.brand.id, f.source.id)).toBeNull();
      console.log("DELIVERY_PROCESS_PROOF", JSON.stringify({ requestId: f.submission.requestId,
        firstPid: first.child.pid, secondPid: second.child.pid, pausedBeforeIntent: true, firstExit: first.child.exitCode, secondExit: second.child.exitCode,
        state: closed?.state, runId: closed?.runId }));
    } finally { for (const child of children) await stop(child); }
  });
  it("continuously hands off accepted requests, observes terminal proof and drains without another Start", async () => {
    const f = await accepted(); let starts = 0;
    const coordinator = new DeliveryCoordinator(submissions, journal, {
      target: gateway.target,
      start: async (s, input) => { if (s.requestId === f.submission.requestId) starts++; await gateway.start(s, input); },
      inspect: s => gateway.inspect(s),
    });
    const makeRunner = () => new DeliveryRunner(new PostgresDeliveryScan(db.pool), coordinator,
      { batchSize: 2, concurrency: 2, intervalMs: 100 }, async () => false, () => {});
    const controller = new AbortController(); const running = makeRunner().run(controller.signal);
    try {
      const w = await worker();
      await w.runUntil(async () => {
        await ready(f.submission.workflowId);
        expect(await submissions.active(f.brand.id, f.source.id)).not.toBeNull();
        await client.workflow.getHandle(f.submission.workflowId).signal("deliveryProbeAction", "complete");
        await client.workflow.getHandle(f.submission.workflowId).result();
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && (await journal.get(f.submission.requestId))?.state !== "CLOSED") await delay(50);
        expect((await journal.get(f.submission.requestId))?.state).toBe("CLOSED");
        expect(await submissions.active(f.brand.id, f.source.id)).toBeNull();
      });
    } finally { controller.abort(); await running; }
    await makeRunner().tick(new AbortController().signal);
    expect(starts).toBe(1);
  });
  it("recovers a real Start response loss, confirms local execution and releases only after remote close", async () => {
    const f = await accepted();
    let starts = 0;
    const coordinator = new DeliveryCoordinator(submissions, journal, {
      target: gateway.target,
      start: async (s, input) => { starts++; await gateway.start(s, input); throw new Error("Injected lost successful Start response"); },
      inspect: s => gateway.inspect(s),
    });
    expect((await coordinator.reconcile(f.submission.requestId)).state).toBe("CONFIRMED");
    const handle = client.workflow.getHandle(f.submission.workflowId);
    expect((await handle.fetchHistory()).events?.some(e => e.workflowTaskStartedEventAttributes)).toBe(false);
    const initialCalls = activityCalls;
    const w = await worker();
    await w.runUntil(async () => {
      await ready(f.submission.workflowId);
      expect((await coordinator.reconcile(f.submission.requestId)).observedStatus).toBe("RUNNING");
      expect(await submissions.active(f.brand.id, f.source.id)).not.toBeNull();
      await handle.signal("deliveryProbeAction", "complete");
      const result = await handle.result() as LocalProof;
      expect(result).toEqual({ requestId: f.submission.requestId, hostname: hostname(), platform: process.platform, pid: process.pid });
      const receipt = await coordinator.reconcile(f.submission.requestId);
      expect(receipt).toMatchObject({ state: "CLOSED", observedStatus: "COMPLETED", lastIssue: null });
      expect(await submissions.active(f.brand.id, f.source.id)).toBeNull();
      expect(starts).toBe(1);
      expect(activityCalls - initialCalls).toBe(1);
      const httpReadback = await fetch(`${base}/api/v3/submissions/${f.submission.requestId}/delivery`, { headers });
      expect(await httpReadback.json()).toEqual({ item: receipt });
      const history = await handle.fetchHistory();
      const identities = [...new Set(history.events?.flatMap(e => e.activityTaskStartedEventAttributes ? [e.activityTaskStartedEventAttributes.identity] : []))];
      expect(identities).toEqual([workerIdentity]);
      const proof = { verifiedAt: new Date().toISOString(), address, requestId: f.submission.requestId, workflowId: f.submission.workflowId,
        receipt, localResult: result, activityIdentities: identities, startCalls: starts,
        uiUrl: uiUrl ? `${uiUrl.replace(/\/$/, "")}/namespaces/${gateway.target.namespace}/workflows/${f.submission.workflowId}/${receipt.runId}/timeline` : null };
      await writeFile(join(db.root, "temporal-delivery-proof.json"), JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 });
      console.log("DELIVERY_PROOF", JSON.stringify(proof));
    });
  });
  it("does not accept an existing Workflow with mismatched input under our ID", async () => {
    const f = await accepted();
    await client.workflow.start(gateway.target.workflowType, { workflowId: f.submission.workflowId, taskQueue: gateway.target.taskQueue,
      args: [{ ...workflowInput(f.submission), requestId: randomUUID() }], workflowExecutionTimeout: "2 minutes" });
    const coordinator = new DeliveryCoordinator(submissions, journal, gateway);
    expect((await coordinator.reconcile(f.submission.requestId)).lastIssue).toBe("IDENTITY_MISMATCH");
    expect(await submissions.active(f.brand.id, f.source.id)).not.toBeNull();
    await client.workflow.getHandle(f.submission.workflowId).terminate("End intentionally mismatched isolated fixture before next test");
  });
  it("keeps the guard when a real Continue-As-New produces another run, even after that run completes", async () => {
    const f = await accepted();
    const coordinator = new DeliveryCoordinator(submissions, journal, gateway);
    const first = await coordinator.reconcile(f.submission.requestId);
    const w = await worker();
    await w.runUntil(async () => {
      await ready(f.submission.workflowId);
      await client.workflow.getHandle(f.submission.workflowId).signal("deliveryProbeAction", "continue");
      const deadline = Date.now() + 15000;
      while ((await client.workflow.getHandle(f.submission.workflowId).describe()).runId === first.runId) {
        if (Date.now() > deadline) throw new Error("Continue-As-New did not advance");
        await delay(100);
      }
      await ready(f.submission.workflowId);
      const observed = await coordinator.reconcile(f.submission.requestId);
      expect(["RUN_CHANGED", "CHAIN_CONTINUED"]).toContain(observed.lastIssue);
      await client.workflow.getHandle(f.submission.workflowId).signal("deliveryProbeAction", "complete");
      await client.workflow.getHandle(f.submission.workflowId).result();
      const closedChild = await coordinator.reconcile(f.submission.requestId);
      expect(closedChild.state).not.toBe("CLOSED");
      expect(await submissions.active(f.brand.id, f.source.id)).not.toBeNull();
    });
  });
});
