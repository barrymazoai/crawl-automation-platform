import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "./config";

export async function migrate(databaseUrl = loadConfig().databaseUrl!) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const builtDirectory = fileURLToPath(new URL("./migrations", import.meta.url));
  const sourceDirectory = fileURLToPath(new URL("../src/migrations", import.meta.url));
  const directory = await fs.access(builtDirectory).then(() => builtDirectory).catch(() => sourceDirectory);
  try {
    await pool.query("create table if not exists platform_schema_migration(version text primary key, applied_at timestamptz not null default now())");
    for (const filename of (await fs.readdir(directory)).filter((file) => file.endsWith(".sql")).sort()) {
      const version = path.basename(filename, ".sql");
      if ((await pool.query("select 1 from platform_schema_migration where version=$1", [version])).rowCount) continue;
      const sql = await fs.readFile(path.join(directory, filename), "utf8");
      const client = await pool.connect();
      try {
        await client.query("begin"); await client.query(sql);
        await client.query("insert into platform_schema_migration(version) values($1)", [version]);
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
    }
  } finally { await pool.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await migrate();
