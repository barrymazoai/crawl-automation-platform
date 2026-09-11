import pg from "pg";
import { V3DatabaseUrl } from "./bootstrap/config.js";
import { loadMigrations, migrate, schemaStatus } from "./bootstrap/schema.js";
import { backup, restore } from "./bootstrap/backup.js";
import { provisionCredentials } from "./bootstrap/credentials.js";

async function main() {
  const [command, directory] = process.argv.slice(2);
  if (!command || !["status", "migrate", "backup", "restore", "credentials"].includes(command) || process.argv.length > 4)
    throw new Error("Use db status|migrate|backup|restore|credentials [absolute directory]");
  const url = new URL(V3DatabaseUrl.parse(process.env.V3_DATABASE_URL));
  const c = { host: url.hostname, port: Number(url.port || "5432"), database: url.pathname.slice(1), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  if (!c.user || !c.password) throw new Error("Explicit dedicated database credentials required");
  const target = `${c.host}:${c.port}/${c.database}`;
  if (command !== "status" && process.env.V3_DB_CONFIRM !== target) throw new Error("V3_DB_CONFIRM must match host:port/database; stop writers first");
  const pool = new pg.Pool({ ...c, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 120_000, options: "-c search_path=public" });
  pool.on("error", () => console.error("V3 database maintenance connection failed"));
  try {
    if (command === "backup") { if (!directory) throw new Error("Backup parent required"); console.log(JSON.stringify({ target, backup: await backup(c, directory) })); return; }
    if (command === "restore") { if (!directory) throw new Error("Trusted backup directory required"); console.log(JSON.stringify({ target, ...await restore(c, directory) })); return; }
    const db = await pool.connect();
    try {
      const migrations = await loadMigrations();
      const result = command === "status" ? await schemaStatus(db, migrations) : command === "credentials"
        ? { credentials: await provisionCredentials(db, directory ?? "") }
        : await migrate(db, migrations, directory ? () => backup(c, directory) : undefined);
      console.log(JSON.stringify({ target, result }));
    } finally { db.release(); }
  } finally { await pool.end(); }
}
main().catch(() => { console.error("V3 database operation failed. Check explicit target/confirmation, migration hashes, trusted backup and empty restore target. No automatic retry or cleanup. Credentials/errors suppressed."); process.exitCode = 1; });
