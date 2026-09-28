// The collection API without web pages: brand/source/submission/schedule/review routes under /api/v3/ plus the
// delivery runner, which starts each accepted submission's workflow and releases the source guard when the run ends.
// A plain API: no web pages, no login. Listens on loopback unless the private config names another address.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import pg from "pg";
import { Connection, Client } from "@temporalio/client";
import { createApp } from "../../v3-api/src/http/app.js";
import { PostgresBrands } from "../../v3-api/src/storage/postgres-brands.js";
import { PostgresDashboard } from "../../v3-api/src/storage/postgres-dashboard.js";
import { PostgresSubmissions } from "../../v3-api/src/storage/postgres-submissions.js";
import { PostgresDelivery } from "../../v3-api/src/storage/postgres-delivery.js";
import { PostgresDeliveryScan } from "../../v3-api/src/storage/postgres-delivery-scan.js";
import { DeliveryCoordinator } from "../../v3-api/src/delivery/coordinator.js";
import { TemporalGateway } from "../../v3-api/src/delivery/temporal-gateway.js";
import { RoutedDeliveryCoordinator } from "../../v3-api/src/delivery/routed-coordinator.js";
import { DeliveryRunner } from "../../v3-api/src/delivery/runner.js";
import { parseDeliverySettings } from "../../v3-api/src/bootstrap/delivery-config.js";
import { migrationNames, digest, schemaStatus } from "../../v3-api/src/bootstrap/schema.js";
import { TemporalSchedules } from "../../v3-api/src/schedules/service.js";
import { scheduleSourceReader } from "../../v3-api/src/schedules/source-reader.js";
import { PostgresReviews, ReviewInspector } from "@crawl-automation/v3-review";
import { WorkerHealthFile } from "../../../packages/v3-worker-runtime/src/health.js";
import { readGncPrivateJson } from "./gnc-config.js";

// Reads the former brand-web private config (fields this service does not use are ignored), plus an optional listen address.
export const CollectionApiConfigSchema = z.object({ databaseUrl: z.string(),
  port: z.number().int().min(1024).max(65535), host: z.string().regex(/^(127\.0\.0\.1|100\.\d{1,3}\.\d{1,3}\.\d{1,3})$/).default("127.0.0.1"),
  delivery: z.unknown(), ui: z.array(z.strictObject({ clusterId: z.string(), baseUrl: z.url() })) });
const MAX_BODY = 16384;

async function main() {
  if (!process.env.V3_COLLECTION_API_CONFIG) throw Error("V3_COLLECTION_API_CONFIG required");
  const c = CollectionApiConfigSchema.parse(await readGncPrivateJson(process.env.V3_COLLECTION_API_CONFIG));
  const delivery = parseDeliverySettings(c.databaseUrl, c.delivery);
  if (delivery.target.workflowType !== "BrandCollectionWorkflow") throw Error("Wrong delivery target");
  const db = new pg.Pool({ connectionString: c.databaseUrl, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  db.on("error", e => console.error(JSON.stringify({ event: "DB_POOL_ERROR", message: String(e?.message).slice(0, 160) })));
  const t = delivery.transport;
  const connection = await Connection.connect({ address: delivery.address, connectTimeout: "20 seconds", ...(t.mode === "mtls" ? { tls: {
    serverNameOverride: t.serverName, serverRootCACertificate: await readFile(t.caFile), clientCertPair: { crt: await readFile(t.certFile), key: await readFile(t.keyFile) } } } : {}) });
  const signal = new AbortController(); process.once("SIGINT", () => signal.abort()); process.once("SIGTERM", () => signal.abort());
  const health = process.env.V3_WORKER_HEALTH_FILE ? new WorkerHealthFile(process.env.V3_WORKER_HEALTH_FILE) : undefined;
  const root = dirname(fileURLToPath(import.meta.url));
  const migrations = await Promise.all(migrationNames.map(async name => { const sql = await readFile(resolve(root, "migrations", name), "utf8"); return { name, sql, sha256: digest(sql) }; }));
  if ((await schemaStatus(db, migrations)).pending.length) throw Error("Explicit migration required");
  const submissions = new PostgresSubmissions(db), journal = new PostgresDelivery(db), reviews = new PostgresReviews(db);
  const client = new Client({ connection, namespace: delivery.target.namespace });
  const schedules = new TemporalSchedules(client, { clusterId: delivery.target.clusterId, namespace: delivery.target.namespace,
    taskQueue: "v3.schedule.intake.workflow.v1.schedule-v1" }, scheduleSourceReader(db));
  const app = createApp(new PostgresBrands(db), { submissions, delivery: journal, acceptSubmissions: true, schedules,
    dashboard: new PostgresDashboard(db, c.ui), reviews, reviewInspector: new ReviewInspector(reviews), collectionUi: { environment: "isolated-live", temporalUi: c.ui } });
  const coordinator = delivery.channelTargets
    ? new RoutedDeliveryCoordinator(submissions, journal, delivery.channelTargets, target => new TemporalGateway(client, target), delivery.target)
    : new DeliveryCoordinator(submissions, journal, new TemporalGateway(client, delivery.target));
  const runner = new DeliveryRunner(new PostgresDeliveryScan(db), coordinator, delivery,
    async () => { try { await stat(delivery.pauseFile); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } },
    event => console.log(JSON.stringify(event)));
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, `http://${c.host}:${c.port}`);
      if (!url.pathname.startsWith("/api/v3/")) { res.writeHead(404); res.end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
      // Only these request headers reach the API.
      const headers = new Headers();
      for (const name of ["content-type", "idempotency-key"]) if (typeof req.headers[name] === "string") headers.set(name, req.headers[name]);
      const response = await app.request(url.pathname + url.search, { method: req.method ?? "GET", headers, ...(size ? { body: Buffer.concat(chunks) } : {}) });
      res.writeHead(response.status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(await response.text());
    } catch { res.writeHead(503); res.end('{"error":{"code":"UNAVAILABLE","message":"Collection API unavailable"}}'); }
  });
  await new Promise<void>((ok, no) => { server.once("error", no); server.listen(c.port, c.host, ok); });
  await health?.report({ event: "WORKER_RUNNING", role: "collection-api" }); const timer = setInterval(() => { void health?.flush(); }, 5000);
  console.log(JSON.stringify({ event: "COLLECTION_API_READY", url: `http://${c.host}:${c.port}/api/v3/` }));
  try { await runner.run(signal.signal); }
  finally { clearInterval(timer); await new Promise<void>(ok => server.close(() => ok())); await connection.close(); await db.end(); await health?.report({ event: "WORKER_STOPPED" }); }
}
if (process.argv[1]?.endsWith("collection-api.js"))
  main().then(() => process.exit(0), error => { console.error(JSON.stringify({ event: "COLLECTION_API_FAILED", message: String(error?.message).slice(0, 200) })); process.exit(1); });
