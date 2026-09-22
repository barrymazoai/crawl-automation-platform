import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { loadMigrations, migrate } from "../src/bootstrap/schema.js";

/** Opt-in for the Mini, which has Docker PostgreSQL but no host initdb. Always a
 * newly named container on a random loopback port; never accepts a database URL. */
export async function startDockerTestDatabase(image: string, empty = false) {
  if (!/^(barrydeMac-mini|servers-Mac-mini)(?:\.|$)/.test(hostname())) throw Error("Run integration on Mac mini");
  if (!/^postgres:(?:16|17|18)(?:-alpine)?$/.test(image)) throw Error("Explicit PostgreSQL test image required");
  const exec = promisify(execFile), name = `v3-queue-test-${randomUUID()}`, root = await mkdtemp(join(tmpdir(), "v3-queue-test-"));
  const opts = { timeout: 30000, maxBuffer: 1024 * 1024 };
  await exec("docker", ["run", "--pull=never", "--detach", "--name", name, "--label", "v3.isolated-test=true",
    "--publish", "127.0.0.1::5432", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_USER=v3_api_test",
    "--env", "POSTGRES_DB=crawler_v3_test", "--tmpfs", image.startsWith("postgres:18") ? "/var/lib/postgresql" : "/var/lib/postgresql/data", image], opts);
  let pool: pg.Pool | undefined;
  const stop = async () => {await exec("docker", ["stop", "--time", "10", name], opts);await exec('docker',['rm',name],opts);};
  try {
    const binding = (await exec("docker", ["port", name, "5432/tcp"], opts)).stdout.trim();
    if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw Error("Unexpected isolated test port");
    const databaseUrl = `postgresql://v3_api_test@${binding}/crawler_v3_test`;
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 2000, statement_timeout: 5000 });
    pool.on("error", () => {});
    let ready = false;
    for (let i = 0; i < 40; i++) { try { await pool.query("SELECT 1"); ready = true; break; } catch { await delay(250); } }
    if (!ready) throw Error("Isolated test PostgreSQL did not start");
    if (!empty) { const c = await pool.connect(); try { await migrate(c, await loadMigrations()); } finally { c.release(); } }
    const active = pool;
    return { pool: active, root, databaseUrl, close: async () => { try { await active.end(); } finally { await stop(); }
      console.log(`Stopped isolated PostgreSQL container ${name}`); } };
  } catch (e) { await pool?.end(); await stop(); throw e; }
}
