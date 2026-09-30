import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { z } from "zod";
import { assertEmpty, assertV3Database, digest, loadMigrations, schemaStatus } from "./schema.js";

const exec = promisify(execFile);
export type DbConnection = { host: string; port: number; user: string; password: string; database: string };
const Manifest = z.strictObject({ format: z.literal(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), database: z.enum(["crawler_v3_dev", "crawler_v3_test"]),
  createdAt: z.string().datetime(), applied: z.number().int().nonnegative(), recovery: z.literal("quarantine-required") });
function nativeOptions(c: DbConnection) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PG")) delete env[key];
  // Credentials go to the child environment, never command arguments or logs.
  Object.assign(env, { PGHOST: c.host, PGPORT: String(c.port), PGUSER: c.user, PGPASSWORD: c.password, PGDATABASE: c.database,
    PGCONNECT_TIMEOUT: "5", PGSSLMODE: "disable", PGOPTIONS: "-c search_path=public -c statement_timeout=60000" });
  return { env, timeout: 90_000, maxBuffer: 1024 * 1024 };
}
export async function backup(c: DbConnection, parent: string) {
  if (!isAbsolute(parent)) throw new Error("Absolute existing backup parent required");
  const dir = await mkdtemp(join(parent, "v3-backup-"));
  await chmod(dir, 0o700);
  const db = new pg.Client({ ...c, connectionTimeoutMillis: 3000 });
  await db.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const state = await schemaStatus(db, await loadMigrations());
    if (!state.applied) throw new Error("Backup requires a versioned V3 database");
    const snapshot = (await db.query("SELECT pg_export_snapshot() AS id")).rows[0].id;
    const file = join(dir, "database.dump");
    await exec("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--no-password", `--snapshot=${snapshot}`, `--file=${file}`], nativeOptions(c));
    await chmod(file, 0o600);
    const manifest = { format: 1, database: c.database, createdAt: new Date().toISOString(), sha256: digest(await readFile(file)), applied: state.applied, recovery: "quarantine-required" };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
    await db.query("COMMIT");
    return dir;
  } finally { await db.end(); }
}
export async function restore(c: DbConnection, dir: string) {
  if (!isAbsolute(dir)) throw new Error("Absolute trusted backup directory required");
  const manifest = Manifest.parse(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")));
  const file = join(dir, "database.dump");
  if (!(await stat(file)).isFile() || digest(await readFile(file)) !== manifest.sha256) throw new Error("Backup checksum mismatch");
  const db = new pg.Client({ ...c, connectionTimeoutMillis: 3000 });
  await db.connect();
  try {
    await assertV3Database(db);
    await db.query("SELECT pg_advisory_lock(73110311)");
    await assertEmpty(db);
    // Commit quarantine BEFORE restoring. Even failed/interrupted restores cannot become runnable.
    await db.query("CREATE TABLE public.v3_restore_hold (created_at timestamptz NOT NULL DEFAULT now(), reason text NOT NULL)");
    await db.query("INSERT INTO public.v3_restore_hold(reason) VALUES ('Snapshot may omit external Start/write receipts; manual reconciliation required')");
    await exec("pg_restore", ["--no-owner", "--no-acl", "--no-password", "--single-transaction", `--dbname=${c.database}`, file], nativeOptions(c));
    const rows: { name: string; sha256: string }[] = (await db.query("SELECT name,sha256 FROM public.v3_local_migration ORDER BY name")).rows;
    const known = await loadMigrations();
    if (rows.length !== manifest.applied || rows.some((row, i) => row.name !== known[i]?.name || row.sha256 !== known[i]?.sha256))
      throw new Error("Restored ledger does not match the trusted migration set/manifest; quarantine retained");
    return { restored: true, quarantined: true, source: manifest.database };
  } finally { await db.end(); }
}
