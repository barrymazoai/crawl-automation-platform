import { migrationErrors } from "@crawl-automation/app";
import { createLogger, type Database, type Queryable } from "@crawl-automation/platform";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrationDigest } from "../migrations/sql-catalog.js";
import { migrationConnectionUrl, PostgresMigrationRepository } from "./migration-repository.js";

const createDatabase = vi.hoisted(() => vi.fn());
vi.mock("@crawl-automation/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@crawl-automation/platform")>()),
  createDatabase,
}));

const connection = {
  host: "localhost",
  port: 5432,
  database: "crawler_v3_test",
  user: "operator",
  password: "p@ss:word",
};
const sql = "BEGIN; SELECT 1; COMMIT;";
const catalog = [
  { name: "001_test.sql", sql, bytes: Buffer.from(sql), sha256: migrationDigest(sql) },
];
const logger = createLogger({ name: "migration-test", level: "fatal" });
const target = "localhost:5432/crawler_v3_test";

function fixture() {
  const events: string[] = [];
  const query = vi.fn(async (sql: string) => {
    events.push(sql);
    return sql.startsWith("SELECT current_database()")
      ? [{ database: "crawler_v3_test", hold: null, ledger: null }]
      : [];
  });
  const transaction: Queryable = { query: query as Queryable["query"] };
  const database: Database = {
    ...transaction,
    transaction: async (work) => {
      events.push("begin");
      try {
        const result = await work(transaction);
        events.push("commit");
        return result;
      } catch (cause) {
        events.push("rollback");
        throw cause;
      }
    },
    close: async () => {
      events.push("close");
    },
  };
  createDatabase.mockReturnValue(database);
  return { events, repository: new PostgresMigrationRepository({ connection, catalog, logger }) };
}

describe("migration database session", () => {
  beforeEach(() => {
    createDatabase.mockReset();
  });

  it("refuses target mismatch before creating a database connection", () => {
    const { repository } = fixture();
    expect(() => repository.withLock("wrong", async () => undefined)).toThrow(
      expect.objectContaining({ code: "MIGRATION.CONFIRMATION_REQUIRED" }),
    );
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("locks before the service callback, commits afterwards and always closes", async () => {
    const { events, repository } = fixture();
    await repository.withLock(target, async () => {
      events.push("service");
    });
    expect(events).toEqual([
      "begin",
      "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
      "SELECT pg_advisory_xact_lock(73110311)",
      "SET LOCAL search_path=public; SET LOCAL lock_timeout='5s'",
      "service",
      "commit",
      "close",
    ]);
  });

  it("propagates the actual service failure through rollback and connection closure", async () => {
    const { events, repository } = fixture();
    const failure = migrationErrors.create("MIGRATION.HISTORY_INVALID");
    await expect(
      repository.withLock(target, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(events.slice(-2)).toEqual(["rollback", "close"]);
    expect(events).not.toContain("commit");
  });

  it("sets a read-only snapshot before status and never initializes a ledger", async () => {
    const { events, repository } = fixture();
    expect(await repository.status()).toEqual({ applied: [], pending: ["001_test.sql"] });
    expect(events[1]).toBe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(events.some((event) => event.includes("CREATE") || event.includes("advisory"))).toBe(
      false,
    );
    expect(events.slice(-2)).toEqual(["commit", "close"]);
  });

  it("escapes credentials and pins all database target fields in the platform connection", () => {
    const url = new URL(migrationConnectionUrl(connection));
    expect(decodeURIComponent(url.password)).toBe(connection.password);
    expect(url.hostname).toBe(connection.host);
    expect(url.pathname).toBe(`/${connection.database}`);
    expect(url.searchParams.get("sslmode")).toBe("disable");
    expect(url.searchParams.get("options")).toBe("-c search_path=public");
  });
});
