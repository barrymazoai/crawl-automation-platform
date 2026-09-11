import pg from "pg";
import { serve } from "@hono/node-server";
import { loadConfig, loadTemporalUi } from "./bootstrap/config.js";
import { assertSchemaReady } from "./bootstrap/schema.js";
import { createApp } from "./http/app.js";
import { PostgresReviews, ReviewInspector } from "@crawl-automation/v3-review";
import { PostgresBrands } from "./storage/postgres-brands.js";
import { PostgresSubmissions } from "./storage/postgres-submissions.js";
import { PostgresDelivery } from "./storage/postgres-delivery.js";
import { PostgresDashboard } from "./storage/postgres-dashboard.js";

async function main() {
  const config = loadConfig(process.env);
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    options: "-c search_path=public",
    max: 8,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
  });
  pool.on("error", () => console.error("V3 database connection error"));
  try {
    // Read-only startup capability check. Never auto-migrate a database at boot.
    await assertSchemaReady(pool);
    const app = createApp(new PostgresBrands(pool), config.token, {
      dashboard: new PostgresDashboard(pool, loadTemporalUi(process.env)),
      reviews: new PostgresReviews(pool), reviewInspector: new ReviewInspector(new PostgresReviews(pool)),
      submissions: new PostgresSubmissions(pool), acceptSubmissions: false,
      delivery: new PostgresDelivery(pool),
    });
    const server = serve({
      fetch: app.fetch,
      hostname: "127.0.0.1",
      port: config.port,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    console.log(
      `V3 API listening at http://127.0.0.1:${config.port}; new DB only; collection disabled`,
    );
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    const force = setTimeout(() => {
      if ("closeAllConnections" in server) server.closeAllConnections();
    }, 5000);
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } finally {
      clearTimeout(force);
    }
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    "V3 API startup/shutdown failed. Check isolated database schema and V3 configuration; no automatic migration was performed.",
  );
  process.exitCode = 1;
});
