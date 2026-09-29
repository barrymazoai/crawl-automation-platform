import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PostgresDatabase, type Database } from "@crawl-automation/platform";
import pg from "pg";

const exec = promisify(execFile);
const PORT = 55441;
const USER = "v3_test";

export interface TemporaryPostgres {
  database: Database;
  stop(): Promise<void>;
}

interface Cluster {
  root: string;
  data: string;
  socket: string;
  options: { env: NodeJS.ProcessEnv; timeout: number };
}

/**
 * A throwaway local PostgreSQL with every V3 migration applied: a private Unix socket only, no TCP listener,
 * never an existing instance. Needs `initdb` and `pg_ctl` (Postgres 18) on PATH.
 */
export async function startTemporaryPostgres(): Promise<TemporaryPostgres> {
  const cluster = await createCluster();
  const { data, socket, options } = cluster;
  const logFile = join(cluster.root, "postgres.log");
  const serverOptions = `-h '' -k '${socket}' -p ${PORT}`;
  await exec("pg_ctl", ["-D", data, "-l", logFile, "-o", serverOptions, "-w", "start"], options);
  const pool = new pg.Pool({ host: socket, port: PORT, user: USER, database: "postgres", max: 4 });
  await applyMigrations(pool);
  return {
    database: new PostgresDatabase(pool),
    stop: async () => {
      await pool.end();
      await exec("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"], options);
    },
  };
}

async function createCluster(): Promise<Cluster> {
  const root = await mkdtemp(join(tmpdir(), "v3-adapters-"));
  const data = join(root, "data");
  const socket = join(root, "socket");
  await mkdir(socket, { mode: 0o700 });
  // Never inherit connection targets or password files from the machine.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PG")),
  );
  const options = { env, timeout: 60_000 };
  const auth = ["--auth-local=trust", "--auth-host=reject"];
  await exec("initdb", ["-D", data, "-U", USER, ...auth, "--no-locale", "-E", "UTF8"], options);
  return { root, data, socket, options };
}

async function applyMigrations(pool: pg.Pool): Promise<void> {
  const directory = new URL("../../../database/v3/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
  for (const name of names) {
    await pool.query(await readFile(new URL(name, directory), "utf8"));
  }
}
