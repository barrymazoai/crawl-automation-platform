import { createLogger, type Queryable } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { migrationDigest, type SqlMigration } from "../migrations/sql-catalog.js";
import { runPendingMigrations } from "../migrations/umzug-runner.js";
import { MigrationHistoryRepository } from "./migration-history-repository.js";

const catalog: SqlMigration[] = [1, 2, 3].map((version) => {
  const sql = `BEGIN; SELECT ${version}; COMMIT;`;
  return {
    name: `00${version}_test.sql`,
    sql,
    bytes: Buffer.from(sql),
    sha256: migrationDigest(sql),
  };
});

function fixture(applied = 1) {
  const rows = catalog.slice(0, applied).map(({ name, sha256 }) => ({ name, sha256 }));
  const query = vi.fn(async (sql: string, values?: string[]) => {
    if (sql.startsWith("SELECT current_database()")) {
      return [{ database: "crawler_v3_test", hold: null, ledger: "v3_local_migration" }];
    }
    if (sql.startsWith("SELECT name,sha256")) {
      return rows;
    }
    if (sql.startsWith("INSERT INTO") && values?.[0] && values[1]) {
      rows.push({ name: values[0], sha256: values[1] });
    }
    return [];
  });
  const database: Queryable = { query: query as Queryable["query"] };
  return {
    rows,
    query,
    database,
    history: new MigrationHistoryRepository(database, catalog),
  };
}

describe("Umzug custom history storage", () => {
  it("returns the validated ordered prefix without any write", async () => {
    const fake = fixture(2);
    expect(await fake.history.executed()).toEqual(catalog.slice(0, 2).map(({ name }) => name));
    expect(fake.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  });

  it.each(["sha256", "name"] as const)(
    "rejects a changed %s before Umzug can filter it",
    async (field) => {
      const fake = fixture(2);
      const first = fake.rows[0];
      if (!first) {
        throw new Error("fixture history missing");
      }
      first[field] = "changed";
      await expect(fake.history.executed()).rejects.toMatchObject({
        code: "MIGRATION.HISTORY_INVALID",
      });
    },
  );

  it("refuses down/history removal", async () => {
    await expect(fixture().history.unlogMigration()).rejects.toMatchObject({
      code: "MIGRATION.FORWARD_ONLY",
    });
  });

  it("Umzug executes only pending bodies and records the original name and hash after each", async () => {
    const fake = fixture();
    await runPendingMigrations({
      database: fake.database,
      catalog,
      logger: createLogger({ name: "migration-test", level: "fatal" }),
    });
    const executions = fake.query.mock.calls.filter(
      ([sql]) => sql.startsWith(" SELECT") || sql.startsWith("INSERT INTO"),
    );
    expect(executions).toEqual(
      catalog
        .slice(1)
        .flatMap((migration, index) => [
          [` SELECT ${index + 2}; `],
          [
            "INSERT INTO public.v3_local_migration(name,sha256) VALUES ($1,$2)",
            [migration.name, migration.sha256],
          ],
        ]),
    );
    expect(fake.rows).toEqual(catalog.map(({ name, sha256 }) => ({ name, sha256 })));
  });
});
