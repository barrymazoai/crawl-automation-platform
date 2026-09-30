import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { loadMigrations, migrate } from "../src/bootstrap/schema.js";
import { startDockerTestDatabase } from "./postgres-docker.js";

const exec = promisify(execFile);
export async function startTestDatabase(options: { tcp?: boolean; empty?: boolean } = {}) {
  if (process.env.V3_TEST_POSTGRES_DOCKER_IMAGE) return startDockerTestDatabase(process.env.V3_TEST_POSTGRES_DOCKER_IMAGE, options.empty);
  const root = await mkdtemp(join(tmpdir(), "v3-api-"));
  const data = join(root, "data"),
    socket = join(root, "socket");
  await mkdir(socket, { mode: 0o700 });
  // Optional authenticated loopback port for a genuinely independent child process.
  let port = 55439;
  const password = options.tcp ? randomUUID() : "";
  if (options.tcp) {
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    await writeFile(join(root, "test-password"), password, { mode: 0o600 });
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PG")) delete env[key];
  const opts = { env, timeout: 20000, maxBuffer: 1024 * 1024 };
  await exec(
    "initdb",
    [
      "-D",
      data,
      "--username=v3_api_test",
      "--auth-local=trust",
      options.tcp ? "--auth-host=scram-sha-256" : "--auth-host=reject",
      ...(options.tcp ? [`--pwfile=${join(root, "test-password")}`] : []),
      "--no-locale",
      "--encoding=UTF8",
    ],
    opts,
  );
  const stop = () =>
    exec("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"], opts);
  let pool: pg.Pool | undefined;
  try {
    await exec(
      "pg_ctl",
      [
        "-D",
        data,
        "-l",
        join(root, "postgres.log"),
        "-o",
        `-h '${options.tcp ? "127.0.0.1" : ""}' -k '${socket}' -p ${port}`,
        "-w",
        "start",
      ],
      opts,
    );
    // Explicitly targeted to our newly created socket directory. No DATABASE_URL.
    pool = new pg.Pool({
      host: socket,
      port,
      user: "v3_api_test",
      password,
      database: "postgres",
      ssl: false,
      max: 8,
      connectionTimeoutMillis: 2000,
      statement_timeout: 5000,
    });
    {
      await pool.query("CREATE DATABASE crawler_v3_test");
      await pool.end();
      pool = new pg.Pool({ host: options.tcp ? "127.0.0.1" : socket, port, user: "v3_api_test", password, database: "crawler_v3_test",
        ssl: false, max: 8, connectionTimeoutMillis: 2000, statement_timeout: 5000 });
    }
    if (!options.empty) {
      const client = await pool.connect();
      try { await migrate(client, await loadMigrations()); } finally { client.release(); }
    }
    const activePool = pool;
    return {
      pool: activePool,
      root,
      // Test-only secret; never write this value into logs or proof reports.
      databaseUrl: options.tcp ? `postgresql://v3_api_test:${password}@127.0.0.1:${port}/crawler_v3_test` : null,
      close: async () => {
        try {
          await activePool.end();
        } finally {
          await stop();
        }
        console.log(`Stopped isolated V3 API database. Test evidence: ${root}`);
      },
    };
  } catch (error) {
    await pool?.end();
    await stop().catch(() => {});
    throw error;
  }
}
