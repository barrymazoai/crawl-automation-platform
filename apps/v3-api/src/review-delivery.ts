import { isAbsolute } from "node:path";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { Client, Connection } from "@temporalio/client";
import { Id, ExecutionIdSchema } from "@crawl-automation/v3-contracts";
import { PostgresReviews, ReviewInspector } from "@crawl-automation/v3-review";
import { assertSchemaReady } from "./bootstrap/schema.js";
import { parseDeliverySettings } from "./bootstrap/delivery-config.js";
import { DeliveryReviewer } from "./delivery/reviewer.js";
import { TemporalGateway } from "./delivery/temporal-gateway.js";
import { PostgresSubmissions } from "./storage/postgres-submissions.js";
import { PostgresDeliveryReader } from "./storage/postgres-delivery.js";

async function main() {
  const unified = process.argv[2] === "--review-id";
  const id = unified ? ExecutionIdSchema.parse(process.argv[3]) : Id.parse(process.argv[2]);
  const path = process.env.V3_REVIEW_CONFIG;
  if (!path || !isAbsolute(path) || process.argv.length !== (unified ? 4 : 3)) throw new Error("Explicit review profile and one request or review ID required");
  const settings = parseDeliverySettings(process.env.V3_DATABASE_URL, JSON.parse(await readFile(path, "utf8")));
  const pool = new pg.Pool({ connectionString: settings.databaseUrl, max: 2, connectionTimeoutMillis: 3000, statement_timeout: 5000,
    options: "-c search_path=public -c default_transaction_read_only=on" });
  pool.on("error", () => console.error("V3 review database unavailable"));
  let connection: Connection | undefined;
  const timeout = setTimeout(() => { console.error("V3 read-only review timed out; no release or retry authorized"); process.exit(1); }, 40_000);
  try {
    await assertSchemaReady(pool);
    const records = new PostgresReviews(pool);
    let requestId=id;
    if (unified) {
      const record = await records.read(id);
      if (!record || record.inspection.kind !== "workflow-delivery") throw new Error("Delivery review required");
      requestId=record.inspection.requestId;
    }
    const t = settings.transport;
    const tls = t.mode === "mtls" ? { serverNameOverride: t.serverName, serverRootCACertificate: await readFile(t.caFile),
      clientCertPair: { crt: await readFile(t.certFile), key: await readFile(t.keyFile) } } : undefined;
    connection = await Connection.connect({ address: settings.address, ...(tls ? { tls } : {}), connectTimeout: "15 seconds" });
    const submissions = new PostgresSubmissions(pool), journal = new PostgresDeliveryReader(pool);
    const receipt=await journal.get(requestId),submission=await submissions.get(requestId);
    const target=receipt?.target??settings.channelTargets?.[submission.snapshot.channel]??settings.target;
    if(target.clusterId!==settings.target.clusterId||target.namespace!==settings.target.namespace)throw Error("Foreign delivery cluster");
    const gateway = new TemporalGateway(new Client({ connection, namespace: settings.target.namespace }), target);
    const reviewer = new DeliveryReviewer({ get: id => submissions.get(id) }, { get: id => journal.get(id) }, { target: gateway.target, inspect: s => gateway.inspect(s) });
    console.log(JSON.stringify(unified ? await new ReviewInspector(records, { delivery: reviewer }).inspect(id) : await reviewer.inspect(id), null, 2));
  } finally {
    try { await connection?.close(); } finally { await pool.end(); clearTimeout(timeout); }
  }
}
main().catch(() => { console.error("V3 read-only review failed; check explicit request/profile/isolated database. No state was changed."); process.exitCode = 1; });
