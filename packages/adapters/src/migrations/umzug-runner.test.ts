import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MigrationService } from "@crawl-automation/app";
import { createDatabase, createLogger, type Database } from "@crawl-automation/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  migrationConnectionUrl,
  PostgresMigrationRepository,
} from "../postgres/migration-repository.js";
import type { MigrationConnection } from "../postgres/backup-repository.js";
import { loadSqlCatalog, type SqlMigration } from "./sql-catalog.js";

function required<Value>(value: Value | null | undefined): Value {
  if (value == null) {
    throw new Error("expected test value");
  }
  return value;
}

const execute = promisify(execFile);
const logger = createLogger({ name: "migration-test", level: "fatal" });
const hasPostgres = (() => {
  try {
    for (const executable of ["initdb", "pg_ctl", "pg_dump", "pg_restore"]) {
      execFileSync(executable, ["--version"]);
    }
    return true;
  } catch {
    return false;
  }
})();
describe.skipIf(!hasPostgres || process.env.V3_TEST_SKIP_POSTGRES === "1")(
  "migrations against isolated PostgreSQL",
  () => {
    let root: string;
    let connection: MigrationConnection;
    let database: Database;
    let catalog: SqlMigration[];
    let started = false;
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("PG")),
    );
    const nativeOptions = { env: environment, timeout: 60_000 };
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "v3-migrate-"));
      const socket = join(root, "socket");
      const data = join(root, "data");
      await mkdir(socket, { mode: 0o700 });
      await execute(
        "initdb",
        [
          "-D",
          data,
          "-U",
          "migration_test",
          "--auth-local=trust",
          "--auth-host=reject",
          "--no-locale",
          "-E",
          "UTF8",
        ],
        nativeOptions,
      );
      await execute(
        "pg_ctl",
        [
          "-D",
          data,
          "-l",
          join(root, "postgres.log"),
          "-o",
          `-h '' -k '${socket}' -p 55443`,
          "-w",
          "start",
        ],
        nativeOptions,
      );
      started = true;
      connection = {
        host: socket,
        port: 55443,
        user: "migration_test",
        password: "isolated-test",
        database: "crawler_v3_test",
      };
      const admin = connect({ ...connection, database: "postgres" });
      try {
        await admin.query("CREATE DATABASE crawler_v3_test");
      } finally {
        await admin.close();
      }
      database = connect(connection);
      catalog = await loadSqlCatalog(
        fileURLToPath(new URL("../../../../database/v3/", import.meta.url)),
      );
    }, 120_000);

    afterAll(async () => {
      await database?.close();
      if (started) {
        await execute(
          "pg_ctl",
          ["-D", join(root, "data"), "-m", "fast", "-w", "stop"],
          nativeOptions,
        );
      }
      // Keep the private temporary directory for diagnostics; never add test data to git.
    }, 60_000);

    beforeEach(async () => {
      // Tests create objects outside public too (a whole schema), so every user schema is reset.
      await query(`DO $$ DECLARE target text; BEGIN
        FOR target IN SELECT nspname FROM pg_namespace
          WHERE nspname NOT IN ('information_schema') AND left(nspname, 3) <> 'pg_'
        LOOP EXECUTE format('DROP SCHEMA %I CASCADE', target); END LOOP;
        CREATE SCHEMA public;
      END $$`);
    });

    function connect(settings: MigrationConnection) {
      return createDatabase(
        {
          connectionString: migrationConnectionUrl(settings),
          maxConnections: 4,
          statementTimeoutMs: 120_000,
        },
        logger,
      );
    }
    async function query(sql: string, values?: readonly unknown[]) {
      return { rows: await database.query<Record<string, unknown>>(sql, values) };
    }
    function service(migrations = catalog, pgDump?: string) {
      return new MigrationService(
        new PostgresMigrationRepository({
          connection,
          catalog: migrations,
          logger,
          ...(pgDump ? { pgDump } : {}),
        }),
      );
    }
    function request() {
      return {
        confirmation: `${connection.host}:${connection.port}/${connection.database}`,
        backupDirectory: root,
      };
    }
    /** Build the exact legacy two-column rows independently of the new runner. */
    async function seedLegacy(count: number) {
      await query(
        "CREATE TABLE public.v3_local_migration(name text PRIMARY KEY, sha256 text NOT NULL)",
      );
      for (const migration of catalog.slice(0, count)) {
        await query(migration.sql);
        const digest = createHash("sha256").update(migration.sql).digest("hex");
        await query("INSERT INTO public.v3_local_migration VALUES ($1,$2)", [
          migration.name,
          digest,
        ]);
      }
    }
    async function history() {
      return (await query("SELECT name,sha256 FROM public.v3_local_migration ORDER BY name")).rows;
    }
    async function backups() {
      return (await readdir(root)).filter((name) => name.startsWith("v3-backup-"));
    }
    function sqlMigration(name: string, body: string): SqlMigration {
      const sql = `BEGIN; ${body} COMMIT;`;
      return {
        name,
        sql,
        bytes: Buffer.from(sql),
        sha256: createHash("sha256").update(sql).digest("hex"),
      };
    }
    it("applies only 034 and 035 after existing 001–033 history, then does no replay or backup", async () => {
      await seedLegacy(33);
      await query("INSERT INTO brand(name) VALUES ('Existing brand')");
      const original = await history();
      const dumps = await backups();
      const result = await service().migrate(request());
      const added = [
        [
          "034_amazon_queue_to_shared.sql",
          "48c557b965b4a32fd3c2e76da013ebb5c66948cda10dd1696064c4319ce53a83",
        ],
        [
          "035_html_capture_grants.sql",
          "718ac4d05626e331bcc666684a0e8d2c9f1495e9ef34b16314ee57a6c674cdc7",
        ],
      ].map(([name, sha256]) => ({ name, sha256 }));
      const names = added.map((row) => row.name);
      expect(result.before).toEqual({ applied: original.map((row) => row.name), pending: names });
      expect(result.after).toEqual({ applied: [...result.before.applied, ...names], pending: [] });
      const updated = [...original, ...added];
      expect(await history()).toEqual(updated);
      expect(result.backup).not.toBeNull();
      const table = await query("SELECT to_regclass('html_capture') AS name");
      expect(table.rows[0]?.name).toBe("html_capture");
      const repeated = await service().migrate(request());
      expect(repeated).toEqual({ before: result.after, after: result.after, backup: null });
      expect(await history()).toEqual(updated);
      expect(await backups()).toHaveLength(dumps.length + 1);
      expect((await query("SELECT name FROM brand")).rows).toEqual([{ name: "Existing brand" }]);
    });

    it("applies only pending SQL after an older prefix with one private, hashed snapshot", async () => {
      await seedLegacy(2);
      await query("INSERT INTO brand(name) VALUES ('Retained brand')");
      const original = await history();
      const dumps = await backups();
      const result = await service().migrate(request());
      expect(result.before.applied).toHaveLength(2);
      expect(result.after.applied).toHaveLength(35);
      expect((await history()).slice(0, 2)).toEqual(original);
      expect(await backups()).toHaveLength(dumps.length + 1);
      const directory = required(result.backup);
      const file = join(directory, "database.dump");
      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({
        format: 1,
        applied: 2,
        database: "crawler_v3_test",
        recovery: "quarantine-required",
        sha256: createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      });
      for (const [path, mode] of [
        [directory, 0o700],
        [file, 0o600],
        [join(directory, "manifest.json"), 0o600],
      ] as const) {
        expect((await stat(path)).mode & 0o777).toBe(mode);
      }
      const restored = await execute(
        "pg_restore",
        ["--data-only", "--file=-", file],
        nativeOptions,
      );
      expect(restored.stdout).toContain("Retained brand");
      expect(restored.stdout).toContain(required(catalog[1]).sha256);
      expect(restored.stdout).not.toContain(required(catalog[2]).sha256);
    });

    it.each([
      ["changed hash", "UPDATE v3_local_migration SET sha256='changed' WHERE name LIKE '001_%'"],
      ["gap", "DELETE FROM v3_local_migration WHERE name LIKE '001_%'"],
      ["unknown version", "INSERT INTO v3_local_migration VALUES ('999_unknown.sql','unknown')"],
      [
        "reordered name",
        "UPDATE v3_local_migration SET name='000_first.sql' WHERE name LIKE '001_%'",
      ],
    ])("rejects %s before backup or DDL", async (_case, damage) => {
      await seedLegacy(2);
      await query(damage);
      const original = await history();
      const dumps = await backups();
      await expect(service().migrate(request())).rejects.toMatchObject({
        code: "MIGRATION.HISTORY_INVALID",
      });
      await expect(service().status()).rejects.toMatchObject({ code: "MIGRATION.HISTORY_INVALID" });
      expect(await history()).toEqual(original);
      expect(await backups()).toEqual(dumps);
    });

    it("rejects a changed release file against the legacy hash", async () => {
      await seedLegacy(2);
      const first = required(catalog[0]);
      const sql = `-- changed\n${first.sql}`;
      const changedCatalog = [
        {
          ...first,
          sql,
          bytes: Buffer.from(sql),
          sha256: createHash("sha256").update(sql).digest("hex"),
        },
        ...catalog.slice(1),
      ];
      await expect(service(changedCatalog).migrate(request())).rejects.toMatchObject({
        code: "MIGRATION.HISTORY_INVALID",
      });
    });

    it("rejects restore quarantine even with valid history", async () => {
      await seedLegacy(2);
      await query("CREATE TABLE public.v3_restore_hold(reason text)");
      const dumps = await backups();
      await expect(service().migrate(request())).rejects.toMatchObject({
        code: "MIGRATION.QUARANTINED",
      });
      await expect(service().status()).rejects.toMatchObject({ code: "MIGRATION.QUARANTINED" });
      expect(await backups()).toEqual(dumps);
    });

    it.each([
      [false, "CREATE TABLE foreign_data(id integer)"],
      [true, "CREATE TABLE foreign_data(id integer)"],
      [false, "CREATE TYPE foreign_type AS ENUM ('value')"],
      [false, "CREATE SCHEMA foreign_schema"],
    ])("rejects unversioned objects (ledger=%s): %s", async (ledger, sql) => {
      if (ledger) {
        await seedLegacy(0);
      }
      await query(sql);
      await expect(service().migrate(request())).rejects.toMatchObject({
        code: "MIGRATION.UNVERSIONED",
      });
      expect((await query("SELECT to_regclass('brand') AS name")).rows[0]?.name).toBeNull();
    });

    it("a failed pg_dump stops all SQL and leaves no valid manifest", async () => {
      await seedLegacy(2);
      const dumps = await backups();
      await expect(
        service(catalog, join(root, "missing-pg-dump")).migrate(request()),
      ).rejects.toMatchObject({ code: "MIGRATION.BACKUP_FAILED" });
      expect(await history()).toHaveLength(2);
      expect(
        (await query("SELECT to_regclass('collection_submission') AS name")).rows[0]?.name,
      ).toBeNull();
      const created = (await backups()).filter((name) => !dumps.includes(name));
      expect(created).toHaveLength(1);
      expect(await readdir(join(root, required(created[0])))).toEqual(["database.dump"]);
      // A subsequent status proves the failed operation closed its connection and lock.
      expect((await service().status()).applied).toHaveLength(2);
    });

    it("rolls back every pending DDL and history row when a later migration fails", async () => {
      await seedLegacy(2);
      const pending = [
        sqlMigration("003_probe.sql", "CREATE TABLE rollback_probe(id integer);"),
        sqlMigration(
          "004_failure.sql",
          "CREATE TABLE failure_probe(id integer); SELECT missing_column;",
        ),
      ];
      await expect(
        service([...catalog.slice(0, 2), ...pending]).migrate(request()),
      ).rejects.toMatchObject({
        code: "MIGRATION.SQL_FAILED",
        details: { name: "004_failure.sql" },
      });
      expect(await history()).toHaveLength(2);
      const names = await query(`SELECT to_regclass('rollback_probe') AS first,
      to_regclass('failure_probe') AS second`);
      expect(names.rows).toEqual([{ first: null, second: null }]);
    });

    it("serializes two migrators, validates fresh history, and creates exactly one backup", async () => {
      await seedLegacy(2);
      const dumps = await backups();
      const results = await Promise.all([
        service().migrate(request()),
        service().migrate(request()),
      ]);
      expect(
        results.map((result) => result.before.applied.length).sort((left, right) => left - right),
      ).toEqual([2, 35]);
      expect(results.filter((result) => result.backup)).toHaveLength(1);
      expect(await backups()).toHaveLength(dumps.length + 1);
      expect(await history()).toHaveLength(35);
    });

    it("read-only status and dry run create no ledger or backup in an empty database", async () => {
      const dumps = await backups();
      expect((await service().status()).applied).toEqual([]);
      const result = await service().migrate({
        ...request(),
        confirmation: "ignored",
        dryRun: true,
      });
      expect(result.before.pending).toHaveLength(35);
      expect(result.after).toEqual(result.before);
      expect(await backups()).toEqual(dumps);
      expect(
        (await query("SELECT to_regclass('v3_local_migration') AS name")).rows[0]?.name,
      ).toBeNull();
    });

    it("initializes an empty database atomically after an empty snapshot backup", async () => {
      const result = await service(catalog.slice(0, 2)).migrate(request());
      expect(result.before.applied).toEqual([]);
      expect(await history()).toHaveLength(2);
      const manifest = JSON.parse(
        await readFile(join(required(result.backup), "manifest.json"), "utf8"),
      );
      expect(manifest.applied).toBe(0);
    });
  },
);
