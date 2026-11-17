import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresUsageRetention } from "../src/postgres/usage-retention.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";

const hasPostgres = (() => {
  try {
    execFileSync("initdb", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

// The database guard (078) compares with its own clock, so the cleanup runs at the real time too.
const NOW = new Date();
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const signal = () => new AbortController().signal;
const settings = { kinds: ["activity", "preparation"], keepDays: 7 };

describe.skipIf(!hasPostgres)("PostgresUsageRetention", () => {
  let postgres: TemporaryPostgres;
  const retention = () => new PostgresUsageRetention(postgres.database, { now: () => NOW });

  async function seed(rows: { kind: string; startedAt: string; count?: number }[]) {
    await postgres.database.query("TRUNCATE usage_event");
    for (const row of rows) {
      for (let i = 0; i < (row.count ?? 1); i += 1) {
        await postgres.database.query(
          `INSERT INTO usage_event (event_id, kind, step, started_at, duration_ms, outcome_code, provider_call, record)
           VALUES ($1, $2, 'step', $3, 1, 'ok', false, '{}')`,
          [randomUUID(), row.kind, row.startedAt],
        );
      }
    }
  }

  const left = async () =>
    postgres.database.query<{ kind: string; n: number }>(
      "SELECT kind, count(*)::int AS n FROM usage_event GROUP BY kind ORDER BY kind",
    );

  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  it("removes only timing and reuse rows older than the retention; cost rows and recent rows stay", async () => {
    await seed([
      { kind: "activity", startedAt: daysAgo(8), count: 3 },
      { kind: "preparation", startedAt: daysAgo(30) },
      { kind: "activity", startedAt: daysAgo(6) },
      { kind: "capture", startedAt: daysAgo(40) },
      { kind: "model-text", startedAt: daysAgo(40) },
      { kind: "ocr", startedAt: daysAgo(40) },
    ]);

    const report = await retention().prune(
      { ...settings, maxRows: 100, removeRows: true },
      signal(),
    );

    expect(report).toEqual({
      kinds: ["activity", "preparation"],
      before: daysAgo(7),
      older: 4,
      removed: 4,
      limited: false,
    });
    expect(await left()).toEqual([
      { kind: "activity", n: 1 },
      { kind: "capture", n: 1 },
      { kind: "model-text", n: 1 },
      { kind: "ocr", n: 1 },
    ]);
  });

  it("stops at the per-run limit and says so; the next run continues", async () => {
    await seed([{ kind: "activity", startedAt: daysAgo(10), count: 5 }]);

    const first = await retention().prune({ ...settings, maxRows: 3, removeRows: true }, signal());
    expect(first).toMatchObject({ older: 5, removed: 3, limited: true });

    const second = await retention().prune({ ...settings, maxRows: 3, removeRows: true }, signal());
    expect(second).toMatchObject({ older: 2, removed: 2, limited: false });
    expect(await left()).toEqual([]);
  });

  it("keeps cost rows immutable in the database itself", async () => {
    await seed([{ kind: "capture", startedAt: daysAgo(40) }]);

    await expect(
      postgres.database.query("DELETE FROM usage_event WHERE kind = 'capture'"),
    ).rejects.toThrow(/immutable/);
    await expect(
      postgres.database.query("UPDATE usage_event SET step = 'changed'"),
    ).rejects.toThrow(/immutable/);
    expect(await left()).toEqual([{ kind: "capture", n: 1 }]);
  });

  it("refuses removing a timing row younger than seven days in the database itself", async () => {
    await seed([{ kind: "activity", startedAt: daysAgo(3) }]);

    await expect(
      postgres.database.query("DELETE FROM usage_event WHERE kind = 'activity'"),
    ).rejects.toThrow(/immutable/);
    expect(await left()).toEqual([{ kind: "activity", n: 1 }]);
  });

  it("reports a failure with the rows already removed instead of throwing", async () => {
    const answers: unknown[][] = [[{ rows: 120_000 }], [{ rows: 50_000 }]];
    const failing = new PostgresUsageRetention(
      {
        query: async <Row extends object>() => {
          const answer = answers.shift();
          if (!answer) {
            throw new Error("permission denied for table usage_event");
          }
          return answer as Row[];
        },
      },
      { now: () => NOW },
    );

    const report = await failing.prune(
      { ...settings, maxRows: 500_000, removeRows: true },
      signal(),
    );

    expect(report).toMatchObject({ older: 120_000, removed: 50_000, limited: false });
    expect(report.error).toContain("permission denied");
  });

  it("only counts in a preview", async () => {
    await seed([{ kind: "activity", startedAt: daysAgo(10), count: 4 }]);

    const report = await retention().prune(
      { ...settings, maxRows: 3, removeRows: false },
      signal(),
    );

    expect(report).toMatchObject({ older: 4, removed: 3, limited: true });
    expect(await left()).toEqual([{ kind: "activity", n: 4 }]);
  });
});
