// Explicit test-only fault entry. Not bundled by tsdown and never loaded by normal runtime.
import pg from "pg";
import { Client, Connection } from "@temporalio/client";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { DeliveryTarget, Id } from "@crawl-automation/v3-contracts";
import { V3DatabaseUrl } from "../src/bootstrap/config.js";
import { PostgresSubmissions } from "../src/storage/postgres-submissions.js";
import { PostgresDelivery } from "../src/storage/postgres-delivery.js";
import { TemporalGateway } from "../src/delivery/temporal-gateway.js";
import { DeliveryCoordinator } from "../src/delivery/coordinator.js";

const config = z.strictObject({ requestId: Id, address: z.string().regex(/^127\.0\.0\.1:\d+$/),
  target: DeliveryTarget.refine(t => t.namespace === "default" && t.taskQueue.startsWith("recovery-test-") && t.workflowType === "DeliveryAcceptanceProbe"),
  stage: z.enum(["before_intent", "after_intent", "after_start", "before_terminal_record", "after_terminal_record"]),
}).parse(JSON.parse(await readFile(process.argv[2]!, "utf8")));
const pool = new pg.Pool({ connectionString: V3DatabaseUrl.parse(process.env.V3_DATABASE_URL), max: 2, statement_timeout: 5000, connectionTimeoutMillis: 3000 });
const connection = await Connection.connect({ address: config.address, connectTimeout: "5 seconds" });
const gateway = new TemporalGateway(new Client({ connection, namespace: "default" }), config.target);
const journal = new PostgresDelivery(pool);
const watchdog = setTimeout(() => process.exit(2), 40_000);
async function checkpoint(stage: string) {
  if (config.stage !== stage) return;
  console.log(JSON.stringify({ event: "RECOVERY_CHECKPOINT", stage, requestId: config.requestId, pid: process.pid }));
  // Intentional crash barrier. Default OS SIGTERM/SIGKILL terminates this owned test process.
  await new Promise<void>(() => {});
}
const coordinator = new DeliveryCoordinator(new PostgresSubmissions(pool), {
  get: id => journal.get(id),
  begin: async (id, target, hash) => { await checkpoint("before_intent"); const receipt = await journal.begin(id, target, hash); await checkpoint("after_intent"); return receipt; },
  record: async (id, proof) => {
    const terminal = typeof proof !== "string" && proof.closedAt !== null;
    if (terminal) await checkpoint("before_terminal_record");
    const result = await journal.record(id, proof);
    if (terminal) await checkpoint("after_terminal_record");
    return result;
  },
}, {
  target: gateway.target,
  start: async (s, input) => { await gateway.start(s, input); await checkpoint("after_start"); },
  inspect: s => gateway.inspect(s),
});
try {
  while (true) { await coordinator.reconcile(config.requestId); await delay(50); }
} finally { clearTimeout(watchdog); await connection.close(); await pool.end(); }
