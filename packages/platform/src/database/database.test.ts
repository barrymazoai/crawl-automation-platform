import { describe, expect, it } from "vitest";
import { PostgresDatabase, type PoolLike } from "./database.js";

interface FakePool {
  pool: PoolLike;
  statements: string[];
  released: () => boolean;
}

function fakePool(failingStatement?: string): FakePool {
  const statements: string[] = [];
  let released = false;
  const run = async (sql: string) => {
    statements.push(sql);
    if (sql === failingStatement) {
      throw new Error("query failed");
    }
    return { rows: [{ value: 1 }] };
  };
  const release = () => {
    released = true;
  };
  const pool: PoolLike = {
    query: run,
    connect: async () => ({ query: run, release }),
    end: async () => undefined,
  };
  return { pool, statements, released: () => released };
}

describe("PostgresDatabase", () => {
  it("returns rows", async () => {
    const { pool } = fakePool();
    const database = new PostgresDatabase(pool);

    await expect(database.query("SELECT 1 AS value")).resolves.toEqual([{ value: 1 }]);
  });

  it("commits a transaction that succeeds", async () => {
    const { pool, statements, released } = fakePool();

    await new PostgresDatabase(pool).transaction((tx) => tx.query("UPDATE run SET state = 'x'"));

    expect(statements).toEqual(["BEGIN", "UPDATE run SET state = 'x'", "COMMIT"]);
    expect(released()).toBe(true);
  });

  it("rolls back and rethrows when the work fails", async () => {
    const { pool, statements, released } = fakePool("UPDATE fails");
    const database = new PostgresDatabase(pool);

    await expect(database.transaction((tx) => tx.query("UPDATE fails"))).rejects.toThrow(
      "query failed",
    );
    expect(statements).toEqual(["BEGIN", "UPDATE fails", "ROLLBACK"]);
    expect(released()).toBe(true);
  });
});

it("keeps the original transaction error when rollback also fails", async () => {
  const { pool, released } = fakePool("ROLLBACK");
  const original = new Error("work failed");
  await expect(
    new PostgresDatabase(pool).transaction(async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  expect(released()).toBe(true);
});
