import { readFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import pg from "pg";
import { Client, Connection } from "@temporalio/client";
import { deliveryConfigPath, parseDeliveryConfig } from "./bootstrap/delivery-config.js";
import { DeliveryRunner } from "./delivery/runner.js";
import { DeliveryCoordinator } from "./delivery/coordinator.js";
import { TemporalGateway } from "./delivery/temporal-gateway.js";
import { RoutedDeliveryCoordinator } from "./delivery/routed-coordinator.js";
import { PostgresDeliveryScan } from "./storage/postgres-delivery-scan.js";
import { PostgresDelivery } from "./storage/postgres-delivery.js";
import { PostgresSubmissions } from "./storage/postgres-submissions.js";
import { assertSchemaReady } from "./bootstrap/schema.js";

async function main() {
  const config = parseDeliveryConfig(process.env, JSON.parse(await readFile(deliveryConfigPath(process.env), "utf8")));
  const controller = new AbortController();
  let watchdog: NodeJS.Timeout | undefined;
  const stop = () => {
    if (controller.signal.aborted) return;
    console.log(JSON.stringify({ event: "DELIVERY_DRAINING" }));
    controller.abort();
    watchdog = setTimeout(() => {
      // Never infer cancellation or clear a source guard on process timeout.
      console.error(JSON.stringify({ event: "DELIVERY_DRAIN_TIMEOUT", outcome: "verify_durable_intent_on_restart" }));
      process.exit(1);
    }, config.shutdownMs);
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, options: "-c search_path=public", max: config.concurrency + 2,
    connectionTimeoutMillis: 3000, statement_timeout: 5000, idle_in_transaction_session_timeout: 10_000 });
  pool.on("error", () => console.error(JSON.stringify({ event: "DELIVERY_DATABASE_ERROR" })));
  let connection: Connection | undefined;
  try {
    // Read-only checks; never silently apply migrations or fall back to the old database.
    await assertSchemaReady(pool);
    const tls = config.transport.mode === "mtls" ? {
      serverNameOverride: config.transport.serverName,
      serverRootCACertificate: await readFile(config.transport.caFile),
      clientCertPair: { crt: await readFile(config.transport.certFile), key: await readFile(config.transport.keyFile) },
    } : undefined;
    if (controller.signal.aborted) return;
    connection = await Connection.connect({ address: config.address, ...(tls ? { tls } : {}), connectTimeout: "20 seconds" });
    await connection.withDeadline(Date.now() + 5000, () => connection!.workflowService.describeNamespace({ namespace: config.target.namespace }));
    const client = new Client({ connection, namespace: config.target.namespace });
    const submissions = new PostgresSubmissions(pool), journal = new PostgresDelivery(pool);
    const runner = new DeliveryRunner(new PostgresDeliveryScan(pool),
      config.channelTargets ? new RoutedDeliveryCoordinator(submissions, journal, config.channelTargets, t => new TemporalGateway(client, t), config.target)
        : new DeliveryCoordinator(submissions, journal, new TemporalGateway(client, config.target)),
      config, async () => {
        try { await stat(config.pauseFile); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
      }, (event) => console.log(JSON.stringify(event)));
    console.log(JSON.stringify({ event: "DELIVERY_READY", host: hostname(), pid: process.pid, target: config.target,
      batchSize: config.batchSize, concurrency: config.concurrency }));
    await runner.run(controller.signal);
  } finally {
    try { await connection?.close(); }
    finally {
      try { await pool.end(); }
      finally {
        if (watchdog) clearTimeout(watchdog);
        process.off("SIGINT", stop); process.off("SIGTERM", stop);
      }
    }
  }
  console.log(JSON.stringify({ event: "DELIVERY_STOPPED" }));
}
main().catch(() => {
  console.error(JSON.stringify({ event: "DELIVERY_FATAL", message: "Check explicit V3 configuration, migrated isolated DB, TLS and target; no automatic migration or resubmission was performed" }));
  process.exitCode = 1;
});
