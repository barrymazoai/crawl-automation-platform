import { randomUUID } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startTestDatabase } from "./postgres.js";
import { assertSchemaReady, digest, loadMigrations, migrate, schemaStatus } from "../src/bootstrap/schema.js";
import { backup, restore, type DbConnection } from "../src/bootstrap/backup.js";
import { provisionCredentials } from "../src/bootstrap/credentials.js";
import { PostgresBrands } from "../src/storage/postgres-brands.js";
import { PostgresSubmissions } from "../src/storage/postgres-submissions.js";
import { PostgresDelivery } from "../src/storage/postgres-delivery.js";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { fixture as reviewFixture } from "../../../packages/v3-review/src/testing.fixture.js";

let source: Awaited<ReturnType<typeof startTestDatabase>>, target: typeof source;
let sourceConnection: DbConnection, targetConnection: DbConnection;
let migrations: Awaited<ReturnType<typeof loadMigrations>>;
let archive: string; let requestId: string;
const connection = (url: string): DbConnection => {
  const u = new URL(url); return { host: u.hostname, port: Number(u.port), user: u.username, password: u.password, database: u.pathname.slice(1) };
};
beforeAll(async () => {
  source = await startTestDatabase({ tcp: true, empty: true });
  target = await startTestDatabase({ tcp: true, empty: true });
  sourceConnection = connection(source.databaseUrl!); targetConnection = connection(target.databaseUrl!);
  migrations = await loadMigrations();
});
afterAll(async () => { await source?.close(); await target?.close(); });
async function apply(list = migrations, save?: () => Promise<unknown>) {
  const c = await source.pool.connect(); try { return await migrate(c, list, save); } finally { c.release(); }
}
describe.sequential("explicit isolated database lifecycle", () => {
  it("creates a versioned prefix; repeated migration is a no-op and startup remains read-only", async () => {
    await apply(migrations.slice(0, 2));
    expect(await schemaStatus(source.pool, migrations)).toMatchObject({ applied: 2, pending: migrations.slice(2).map(m => m.name) });
    await apply(migrations.slice(0, 2));
    await expect(assertSchemaReady(source.pool)).rejects.toThrow("migration required");
    expect((await source.pool.query("SELECT count(*) FROM v3_local_migration")).rows[0].count).toBe("2");
  });
  it("refuses existing upgrades without backup, then preserves data through a backed-up upgrade", async () => {
    await source.pool.query("INSERT INTO brand(name) VALUES ('Migration fixture')");
    await expect(apply()).rejects.toThrow("backup");
    let saved: string | undefined; let backupCalls = 0;
    const save = async () => { backupCalls++; saved = await backup(sourceConnection, source.root); };
    await Promise.all([apply(migrations, save), apply(migrations, save)]);
    expect(backupCalls).toBe(1);
    expect(JSON.parse(await readFile(join(saved!, "manifest.json"), "utf8")).applied).toBe(2);
    expect((await source.pool.query("SELECT name FROM brand")).rows[0].name).toBe("Migration fixture");
    await assertSchemaReady(source.pool);
  });
  it("rejects changed, unknown and reordered migrations without writing", async () => {
    await expect(apply(migrations.map((m, i) => i === 0 ? { ...m, sha256: "0".repeat(64) } : m))).rejects.toThrow("changed");
    await expect(apply(migrations.slice(0, 4))).rejects.toThrow("Unknown");
    await expect(apply([...migrations].reverse())).rejects.toThrow("reordered");
    expect((await source.pool.query("SELECT count(*) FROM v3_local_migration")).rows[0].count).toBe(String(migrations.length));
  });
  it("rolls back failed DDL together with its ledger and serializes competing migrators", async () => {
    const sql = "BEGIN; CREATE TABLE rollback_probe(id int); SELECT missing_column FROM brand; COMMIT;";
    await expect(apply([...migrations, { name: "006_test.sql", sql, sha256: digest(sql) }], () => backup(sourceConnection, source.root))).rejects.toThrow();
    expect((await source.pool.query("SELECT to_regclass('rollback_probe') AS name")).rows[0].name).toBeNull();
    expect((await source.pool.query("SELECT count(*) FROM v3_local_migration")).rows[0].count).toBe(String(migrations.length));
    await Promise.all([apply(), apply()]);
  });
  it("checks required capabilities even with a valid version ledger", async () => {
    for (const sql of ["DROP INDEX collection_submission_scan_order", "DROP INDEX review_record_request", "ALTER TABLE review_record DISABLE TRIGGER review_record_immutable",
      "DROP INDEX collected_product_brand", "ALTER TABLE collected_product DISABLE TRIGGER collected_product_immutable"]) {
      const c = await source.pool.connect();
      try {
        await c.query(`BEGIN; ${sql}`);
        await expect(assertSchemaReady(c)).rejects.toThrow(/index missing|trigger missing/);
      } finally { await c.query("ROLLBACK"); c.release(); }
    }
  });
  it("backs up immutable requests, unknown Start receipts and guards with private file permissions", async () => {
    const brands = new PostgresBrands(source.pool);
    const b = (await brands.create({ name: "Restore fixture", note: "synthetic" }, randomUUID())).value;
    const s = (await brands.createSource(b.id, { channel: "dtc", region: "US", url: "https://synthetic.example" }, randomUUID())).value;
    await brands.toggleSource(b.id, s.id, { enabled: true, revision: 1 }, randomUUID());
    const submission = (await new PostgresSubmissions(source.pool).accept(b.id, s.id, { sourceRevision: 2 }, randomUUID())).value;
    requestId = submission.requestId;
    await new PostgresDelivery(source.pool).begin(requestId, { clusterId: "test", namespace: "default", taskQueue: "test", workflowType: "Probe" }, "a".repeat(64));
    await new PostgresReviews(source.pool).append(reviewFixture("backup-review-001"));
    archive = await backup(sourceConnection, source.root);
    expect((await stat(archive)).mode & 0o777).toBe(0o700);
    expect((await stat(join(archive, "database.dump"))).mode & 0o777).toBe(0o600);
  });
  it("rejects damaged backups before touching the target", async () => {
    const path = join(archive, "manifest.json"); const original = await readFile(path, "utf8");
    try {
      await writeFile(path, JSON.stringify({ ...JSON.parse(original), sha256: "0".repeat(64) }));
      await expect(restore(targetConnection, archive)).rejects.toThrow("checksum");
      expect((await target.pool.query("SELECT to_regclass('v3_restore_hold') AS hold")).rows[0].hold).toBeNull();
    } finally { await writeFile(path, original); }
  });
  it("restores only to an empty database and quarantines it against starting delivery", async () => {
    expect(await restore(targetConnection, archive)).toMatchObject({ restored: true, quarantined: true });
    for (const table of ["brand", "brand_source", "api_request_receipt", "collection_submission", "source_submission_guard", "workflow_delivery", "processing_result", "review_record", "collected_product", "v3_local_migration"]) {
      const query = `SELECT row_to_json(t) AS row FROM public.${table} t ORDER BY row_to_json(t)::text`;
      expect((await target.pool.query(query)).rows).toEqual((await source.pool.query(query)).rows);
    }
    await expect(assertSchemaReady(target.pool)).rejects.toThrow("quarantined");
    expect(await new PostgresReviews(target.pool).read("backup-review-001")).toEqual(reviewFixture("backup-review-001"));
    await expect(restore(targetConnection, archive)).rejects.toThrow("not empty");
    const proof = { archive, requestId, tablesMatched: 10, quarantined: true, guard: 1 };
    await writeFile(join(source.root, "maintenance-proof.json"), JSON.stringify(proof, null, 2), { mode: 0o600 });
    console.log("DATABASE_RESTORE_PROOF", JSON.stringify(proof));
  });
  it("creates separate SCRAM roles; review cannot write and runtime cannot migrate or clear each other's data", async () => {
    const admin = await source.pool.connect(); let directory: string;
    try { directory = await provisionCredentials(admin, source.root); } finally { admin.release(); }
    for (const user of ["v3_api", "v3_delivery", "v3_review", "v3_result", "v3_review_writer", "v3_collection"]) {
      const file = join(directory!, `${user}.json`);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const credentials = JSON.parse(await readFile(file, "utf8"));
      const client = new pg.Client({ ...sourceConnection, ...credentials }); await client.connect();
      try {
        await assertSchemaReady(client);
        await expect(client.query("CREATE TABLE public.forbidden(id int)")).rejects.toThrow();
        await expect(client.query("DELETE FROM v3_local_migration")).rejects.toThrow();
        if (user !== "v3_delivery") await expect(client.query("DELETE FROM source_submission_guard")).rejects.toThrow();
        if (user !== "v3_api") await expect(client.query("INSERT INTO brand(name) VALUES ('forbidden')")).rejects.toThrow();
        expect((await client.query("SELECT has_table_privilege(current_user,'public.processing_result','INSERT') AS allowed")).rows[0].allowed).toBe(user === "v3_result");
        expect((await client.query("SELECT has_table_privilege(current_user,'public.review_record','INSERT') AS allowed")).rows[0].allowed).toBe(user === "v3_review_writer");
        expect((await client.query("SELECT has_table_privilege(current_user,'public.collected_product','INSERT') AS allowed")).rows[0].allowed).toBe(user === "v3_collection");
        await expect(client.query("UPDATE collected_product SET record_hash=record_hash")).rejects.toThrow();
        await expect(client.query("DELETE FROM collected_product")).rejects.toThrow();
        await expect(client.query("UPDATE review_record SET record_hash=record_hash")).rejects.toThrow();
        await expect(client.query("DELETE FROM review_record")).rejects.toThrow();
        await expect(client.query("UPDATE processing_result SET record_hash=record_hash")).rejects.toThrow();
        await expect(client.query("DELETE FROM processing_result")).rejects.toThrow();
        if (user === "v3_review") {
          await client.query("SET default_transaction_read_only=off");
          await expect(client.query("DELETE FROM source_submission_guard")).rejects.toThrow("permission denied");
        }
        if (user === "v3_api") await client.query("INSERT INTO brand(name) VALUES ('credential fixture')");
        if (user === "v3_delivery") await client.query("UPDATE workflow_delivery SET checked_at=now() WHERE request_id=$1", [requestId]);
      } finally { await client.end(); }
    }
  });
  it("CLI ignores legacy connection variables, requires exact target confirmation and refuses restored app startup", async () => {
    const exec = promisify(execFile);
    const options = { cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 10_000,
      env: { ...process.env, V3_DATABASE_URL: source.databaseUrl!, DATABASE_URL: "postgresql://secret-canary@invalid/old", PGHOST: "invalid", PGDATABASE: "old" } };
    const result = await exec(process.execPath, ["--import", "tsx", "src/database-cli.ts", "status"], options);
    expect(JSON.parse(result.stdout).result).toMatchObject({ applied: migrations.length, pending: [] });
    await expect(exec(process.execPath, ["--import", "tsx", "src/database-cli.ts", "migrate"], {
      ...options, env: { ...options.env, V3_DB_CONFIRM: "wrong-target" },
    })).rejects.toThrow("V3 database operation failed");
    await expect(exec(process.execPath, ["--import", "tsx", "src/database-cli.ts", "status"], {
      ...options, env: { ...options.env, V3_DATABASE_URL: "" },
    })).rejects.toThrow("V3 database operation failed");
    await expect(exec(process.execPath, ["--import", "tsx", "src/server.ts"], {
      ...options, env: { ...options.env, V3_DATABASE_URL: target.databaseUrl!, V3_API_TOKEN: "test-token-".repeat(8) },
    })).rejects.toThrow("V3 API startup/shutdown failed");
  });
});
