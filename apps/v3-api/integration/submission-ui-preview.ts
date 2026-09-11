// Explicit acceptance harness: synthetic configuration, real DB + Temporal + Worker.
// stdin controls fault injection; there is no HTTP fault/control backdoor.
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { CollectionWorkflowInput } from "@crawl-automation/v3-contracts";
import { startTestDatabase } from "./postgres.js";
import { createApp } from "../src/http/app.js";
import { PostgresBrands } from "../src/storage/postgres-brands.js";
import { PostgresSubmissions } from "../src/storage/postgres-submissions.js";
import { PostgresDelivery } from "../src/storage/postgres-delivery.js";
import { PostgresDeliveryScan } from "../src/storage/postgres-delivery-scan.js";
import { DeliveryCoordinator } from "../src/delivery/coordinator.js";
import { TemporalGateway } from "../src/delivery/temporal-gateway.js";
import { DeliveryRunner } from "../src/delivery/runner.js";

if (process.env.V3_UI_ACCEPTANCE !== "isolated") throw new Error("Explicit isolated UI acceptance opt-in required");
const root = fileURLToPath(new URL("../../web/dist-v3-live/", import.meta.url));
await readFile(join(root, "v3-live.html"));
const db = await startTestDatabase();
let env: TestWorkflowEnvironment | undefined;
let worker: Worker | undefined;
let workerRun: Promise<void> | undefined;
let server: ReturnType<typeof serve> | undefined;
let runnerRun: Promise<void> | undefined;
const controller = new AbortController();
const input = createInterface({ input: process.stdin });
const audit: unknown[] = [];
const event = (data: object) => { const value = { at: new Date().toISOString(), ...data }; audit.push(value); console.log(JSON.stringify(value)); };
try {
  env = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: true, uiPort: 8234,
    executable: { type: "cached-download", version: "v1.8.3" },
  } });
  const brands = new PostgresBrands(db.pool), submissions = new PostgresSubmissions(db.pool), journal = new PostgresDelivery(db.pool);
  const brand = (await brands.create({ name: "提交验收 · 合成 Brand", note: "CRAWLV3-12 隔离验收；不是实际采集" }, randomUUID())).value;
  let source = (await brands.createSource(brand.id, { channel: "dtc", region: "US", url: "https://synthetic.example/products" }, randomUUID())).value;
  source = (await brands.toggleSource(brand.id, source.id, { enabled: true, revision: source.revision }, randomUUID())).value;
  const gateway = new TemporalGateway(env.client, { clusterId: "crawlv3-12-local", namespace: env.client.workflow.options.namespace, taskQueue: `ui-probe-${randomUUID()}`, workflowType: "DeliveryAcceptanceProbe" });
  let paused = true, unavailable = false, rejectNext = false;
  const coordinator = new DeliveryCoordinator(submissions, journal, {
    target: gateway.target,
    start: async (s, payload) => { event({ event: "START", requestId: s.requestId }); await gateway.start(s, payload); },
    inspect: s => { if (unavailable) throw new Error("Injected unavailable inspection"); return gateway.inspect(s); },
  });
  const runner = new DeliveryRunner(new PostgresDeliveryScan(db.pool), coordinator, { batchSize: 10, concurrency: 2, intervalMs: 500 }, async () => paused, () => {});
  worker = await Worker.create({ connection: env.nativeConnection, namespace: gateway.target.namespace, taskQueue: gateway.target.taskQueue,
    workflowsPath: fileURLToPath(new URL("../temporal-tests/workflows.ts", import.meta.url)), identity: `ui-acceptance@${hostname()}:${process.pid}`,
    activities: { echoLocal: async (payload: CollectionWorkflowInput) => { const proof = { requestId: payload.requestId, hostname: hostname(), platform: process.platform, pid: process.pid }; event({ event: "ACTIVITY", ...proof }); return proof; } },
  });
  workerRun = worker.run(); workerRun.catch(error => { event({ event: "WORKER_ERROR", message: String(error) }); controller.abort(); });
  runnerRun = runner.run(controller.signal);
  const token = randomBytes(32).toString("hex");
  const api = createApp(brands, token, { submissions, delivery: journal, acceptSubmissions: true,
    collectionUi: { environment: "isolated-acceptance", temporalUi: [{ clusterId: gateway.target.clusterId, baseUrl: "http://127.0.0.1:8234" }] },
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (c.req.header("host") !== "127.0.0.1:4184") return c.text("Local acceptance only", 403);
    c.header("Cache-Control", "no-store"); await next();
  });
  app.all("/api/v3/*", async c => {
    if (c.req.header("X-V3-Client") !== "local-workspace" ||
        (c.req.header("origin") && c.req.header("origin") !== "http://127.0.0.1:4184") ||
        (c.req.method !== "GET" && c.req.header("origin") !== "http://127.0.0.1:4184")) return c.text("Local acceptance only", 403);
    const req = new Request(c.req.raw); req.headers.set("authorization", `Bearer ${token}`);
    if (rejectNext && c.req.method === "POST" && c.req.path.endsWith("/submissions")) {
      rejectNext = false;
      event({ event: "HTTP", method: "POST", path: c.req.path, status: 502, key: c.req.header("Idempotency-Key"), injected: true });
      return c.json({ error: { code: "ACCEPTANCE_NETWORK_FAULT", message: "Explicit isolated fault injection" } }, 502);
    }
    const result = await api.fetch(req);
    if (c.req.method !== "GET") event({ event: "HTTP", method: c.req.method, path: c.req.path, status: result.status, key: c.req.header("Idempotency-Key") });
    return result;
  });
  app.get("/", c => c.redirect("/v3-live.html")); app.use("*", serveStatic({ root }));
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 4184 });
  await new Promise<void>((resolve,reject) => { server!.once("listening",resolve); server!.once("error",reject); });
  const proof = async () => {
    const rows = (await db.pool.query("SELECT request_id FROM collection_submission ORDER BY created_at")).rows;
    const results = await Promise.all(rows.map(async row => ({ submission: await submissions.get(row.request_id), delivery: await journal.get(row.request_id) })));
    const evidence = { audit, results, active: await submissions.active(brand.id, source.id), address: env!.address, brand, source };
    await writeFile(join(db.root, "submission-ui-proof.json"), JSON.stringify(evidence,null,2), { mode: 0o600 });
    event({ event: "PROOF_SAVED", path: join(db.root, "submission-ui-proof.json"), submissions: rows.length });
  };
  input.on("line", command => { void (async () => {
    switch (command.trim()) {
      case "reject-once": rejectNext = true; break;
      case "unavailable": unavailable = true; break;
      case "resume": paused = false; break;
      case "pause": paused = true; break;
      case "recover": unavailable = false; break;
      case "complete": {
        const rows = (await db.pool.query("SELECT workflow_id FROM collection_submission")).rows;
        for (const row of rows) await env!.client.workflow.getHandle(row.workflow_id).signal("deliveryProbeAction", "complete");
        break;
      }
      case "proof": await proof(); break;
      case "stop": controller.abort(); break;
      default: throw Error("Unknown fixture command");
    }
    event({ event: "CONTROL", command });
  })().catch(error => event({ event: "CONTROL_ERROR", message: String(error) })); });
  event({ event: "UI_READY", url: `http://127.0.0.1:4184/v3-live.html?brand=${brand.id}#collection`, temporalUi: "http://127.0.0.1:8234", evidence: db.root, pid: process.pid });
  process.once("SIGTERM", () => controller.abort()); process.once("SIGINT", () => controller.abort());
  await new Promise<void>(resolve => { if (controller.signal.aborted) resolve(); else controller.signal.addEventListener("abort", () => resolve(), { once: true }); });
  await runnerRun; await proof();
} finally {
  input.close(); controller.abort(); await runnerRun;
  if (server) { if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  if (worker) { worker.shutdown(); await workerRun; }
  if (env) await env.teardown();
  await db.close();
}
