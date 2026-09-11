// Explicit local provisioning entry. Never reads DATABASE_URL or any .env file.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  access,
  rmdir,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { join } from "node:path";
import pg from "pg";
import { serve } from "@hono/node-server";
import { createApp } from "./http/app.js";
import { PostgresReviews, ReviewInspector } from "@crawl-automation/v3-review";
import { PostgresBrands } from "./storage/postgres-brands.js";
import { PostgresSubmissions } from "./storage/postgres-submissions.js";
import { PostgresDelivery } from "./storage/postgres-delivery.js";
import { PostgresDashboard } from "./storage/postgres-dashboard.js";
import { assertSchemaReady, loadMigrations, migrate, schemaStatus } from "./bootstrap/schema.js";
import { backup } from "./bootstrap/backup.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../.local/", import.meta.url));
const data = join(root, "postgres");
const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
async function main() {
  const action = process.env.V3_LOCAL_DB_ACTION;
  if (action && !["status", "migrate", "backup"].includes(action)) throw new Error("Invalid local maintenance action");
  if (action && !(await exists(join(root, "cluster-owner")))) throw new Error("Local maintenance requires an existing owned cluster");
  await mkdir(root, { recursive: true, mode: 0o700 });
  // An exclusive directory lock fails closed after a crash: do not steal locks
  // or attach to another process's database. See README for recovery.
  const lock = join(root, "run.lock");
  await mkdir(lock, { mode: 0o700 });
  await writeFile(
    join(root, "last-owner.json"),
    JSON.stringify({ pid: process.pid }),
    { mode: 0o600 },
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PG")) delete env[key];
  const options = { env, timeout: 30000, maxBuffer: 1024 * 1024 };
  let started = false;
  let pool: pg.Pool | undefined;
  let server: ReturnType<typeof serve> | undefined;
  let createdDatabase = false;
  try {
    const marker = join(root, "cluster-owner");
    if (!(await exists(marker))) {
      if (await exists(data))
        throw new Error("Unmarked database directory: refusing to adopt it");
      await writeFile(marker, "crawler-v3-local-v1", {
        flag: "wx",
        mode: 0o600,
      });
    }
    if ((await readFile(marker, "utf8")) !== "crawler-v3-local-v1")
      throw new Error("Invalid cluster marker");
    if (!(await exists(data))) {
      await exec(
        "initdb",
        [
          "-D",
          data,
          "--username=v3_local",
          "--auth-local=trust",
          "--auth-host=reject",
          "--no-locale",
          "--encoding=UTF8",
        ],
        options,
      );
    }
    const socket = await mkdtemp("/private/tmp/crawler-v3-socket-");
    await exec(
      "pg_ctl",
      [
        "-D",
        data,
        "-l",
        join(root, "postgres.log"),
        "-o",
        `-h '' -k '${socket}' -p 55439`,
        "-w",
        "start",
      ],
      options,
    );
    started = true;
    const connection = {
      host: socket,
      port: 55439,
      user: "v3_local",
      password: "",
      ssl: false as const,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    };
    const admin = new pg.Client({ ...connection, database: "postgres" });
    await admin.connect();
    try {
      const found = await admin.query(
        "SELECT 1 FROM pg_database WHERE datname = 'crawler_v3_dev'",
      );
      if (!found.rowCount) {
        if (action) throw new Error("Local maintenance does not create databases");
        await admin.query("CREATE DATABASE crawler_v3_dev"); createdDatabase = true;
      }
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({
      ...connection,
      database: "crawler_v3_dev",
      max: 8,
      idle_in_transaction_session_timeout: 10000,
    });
    pool.on("error", () => console.error("Local V3 database connection error"));
    const migrations = await loadMigrations();
    const dbConnection = { ...connection, database: "crawler_v3_dev" };
    if (action === "status") { console.log(JSON.stringify(await schemaStatus(pool, migrations))); return; }
    if (action === "backup" || action === "migrate") {
      if (process.env.V3_LOCAL_DB_CONFIRM !== "crawler-v3-local-v1/crawler_v3_dev") throw new Error("Explicit local maintenance confirmation required");
      const backups = join(root, "backups"); await mkdir(backups, { recursive: true, mode: 0o700 });
      const save = async () => { const path = await backup(dbConnection, backups); console.log(JSON.stringify({ backup: path })); return path; };
      if (action === "backup") await save();
      else {
        const client = await pool.connect();
        try { await client.query("SET idle_in_transaction_session_timeout=0"); await migrate(client, migrations, save); }
        finally { client.release(); }
      }
      return;
    }
    if (createdDatabase) {
      const client = await pool.connect();
      try { await migrate(client, migrations); } finally { client.release(); }
    }
    // Existing persistent databases never migrate implicitly on application startup.
    await assertSchemaReady(pool);
    const tokenFile = join(root, "api-token");
    if (!(await exists(tokenFile)))
      await writeFile(tokenFile, randomBytes(32).toString("hex"), {
        flag: "wx",
        mode: 0o600,
      });
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid local token");
    server = serve({
      fetch: createApp(new PostgresBrands(pool), token, {
        dashboard: new PostgresDashboard(pool),
        reviews: new PostgresReviews(pool), reviewInspector: new ReviewInspector(new PostgresReviews(pool)),
        submissions: new PostgresSubmissions(pool), acceptSubmissions: false,
        delivery: new PostgresDelivery(pool),
      }).fetch,
      hostname: "127.0.0.1",
      port: 4180,
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    console.log(
      "Local V3 API ready: http://127.0.0.1:4180; persistent crawler_v3_dev; socket-only PostgreSQL; collection disabled.",
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
  } finally {
    if (server) {
      const timer = setTimeout(() => {
        if (server && "closeAllConnections" in server)
          server.closeAllConnections();
      }, 5000);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      clearTimeout(timer);
    }
    await pool?.end();
    if (started)
      await exec("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"], options);
    await rmdir(lock);
    console.log("Local V3 stopped; database files retained.");
  }
}
main().catch((error: unknown) => {
  console.error(
    "Local V3 startup/shutdown failed:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exitCode = 1;
});
