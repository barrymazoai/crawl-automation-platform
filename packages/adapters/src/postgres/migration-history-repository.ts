import { migrationErrors, type MigrationStatus } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import type { UmzugStorage } from "umzug";
import { validateSqlCatalog, type SqlMigration } from "../migrations/sql-catalog.js";

export type MigrationQuery = Queryable;

/** Umzug storage over the existing two-column ledger; never creates metadata during reads. */
export class MigrationHistoryRepository implements UmzugStorage {
  constructor(
    private readonly database: MigrationQuery,
    private readonly catalog: readonly SqlMigration[],
  ) {
    validateSqlCatalog(catalog);
  }

  async validate(): Promise<MigrationStatus> {
    const hasLedger = await this.checkTarget();
    const rows = hasLedger
      ? await this.database.query<{ name: string; sha256: string }>(
          "SELECT name,sha256 FROM public.v3_local_migration ORDER BY name",
        )
      : [];
    if (!rows.length) {
      await this.assertEmpty(hasLedger);
    }
    for (const [index, row] of rows.entries()) {
      if (row.name !== this.catalog[index]?.name || row.sha256 !== this.catalog[index]?.sha256) {
        throw migrationErrors.create("MIGRATION.HISTORY_INVALID", { details: { name: row.name } });
      }
    }
    return {
      applied: rows.map((row) => row.name),
      pending: this.catalog.slice(rows.length).map((migration) => migration.name),
    };
  }

  private async checkTarget(): Promise<boolean> {
    const marker = await this.database.query<{
      database: string;
      hold: string | null;
      ledger: string | null;
    }>(`SELECT current_database() AS database,
      to_regclass('public.v3_restore_hold') AS hold,
      to_regclass('public.v3_local_migration') AS ledger`);
    const state = marker[0];
    if (!["crawler_v3_dev", "crawler_v3_test"].includes(state?.database ?? "")) {
      throw migrationErrors.create("MIGRATION.TARGET_INVALID");
    }
    if (state?.hold) {
      throw migrationErrors.create("MIGRATION.QUARANTINED");
    }
    return Boolean(state?.ledger);
  }

  async executed(): Promise<string[]> {
    return (await this.validate()).applied;
  }

  async initialize(): Promise<void> {
    await this.database.query(`CREATE TABLE IF NOT EXISTS public.v3_local_migration
      (name text PRIMARY KEY, sha256 text NOT NULL)`);
  }

  async logMigration({ name }: { name: string }): Promise<void> {
    const migration = this.catalog.find((entry) => entry.name === name);
    if (!migration) {
      throw migrationErrors.create("MIGRATION.HISTORY_INVALID", { details: { name } });
    }
    await this.database.query("INSERT INTO public.v3_local_migration(name,sha256) VALUES ($1,$2)", [
      name,
      migration.sha256,
    ]);
  }

  async unlogMigration(): Promise<never> {
    throw migrationErrors.create("MIGRATION.FORWARD_ONLY");
  }

  private async assertEmpty(hasLedger: boolean): Promise<void> {
    const objects = await this.database.query(
      `SELECT 1 FROM pg_class object
      JOIN pg_namespace namespace ON namespace.oid=object.relnamespace
      WHERE namespace.nspname NOT IN ('pg_catalog','information_schema')
        AND namespace.nspname NOT LIKE 'pg_toast%'
        AND NOT ($1 AND (object.oid=to_regclass('public.v3_local_migration')
          OR object.oid IN (SELECT indexrelid FROM pg_index
            WHERE indrelid=to_regclass('public.v3_local_migration'))))
      UNION ALL SELECT 1 FROM pg_proc object
      JOIN pg_namespace namespace ON namespace.oid=object.pronamespace
      WHERE namespace.nspname NOT IN ('pg_catalog','information_schema')
      UNION ALL SELECT 1 FROM pg_type object
      JOIN pg_namespace namespace ON namespace.oid=object.typnamespace
      WHERE namespace.nspname NOT IN ('pg_catalog','information_schema')
        AND object.typtype IN ('d','e')
      UNION ALL SELECT 1 FROM pg_namespace
      WHERE nspname NOT IN ('public','information_schema') AND left(nspname,3) <> 'pg_'
      LIMIT 1`,
      [hasLedger],
    );
    if (objects.length) {
      throw migrationErrors.create("MIGRATION.UNVERSIONED");
    }
  }
}
