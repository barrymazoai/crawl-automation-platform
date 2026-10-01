import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startTemporaryPostgres,
  type TemporaryPostgres,
} from "../../integration/temporary-postgres.js";
import {
  seedHistoricCapture,
  seedMigrationQueue,
  type QueueSeed,
} from "../../integration/migration-fixtures.js";
import { loadSqlCatalog, migrationBody } from "./sql-catalog.js";

// Explicit opt-in on the PostgreSQL test host; never starts a server in the unit-only run.
describe.skipIf(
  process.env.CRAWLER_TEST_POSTGRES !== "1" || process.env.V3_TEST_SKIP_POSTGRES === "1",
)("integration migrations on schema 038", () => {
  let postgres: TemporaryPostgres | undefined;
  beforeEach(async () => {
    postgres = await startTemporaryPostgres(38);
    await postgres.database.query("CREATE ROLE v3_runtime");
  }, 120_000);
  afterEach(async () => postgres?.stop());

  const database = () => {
    if (!postgres) {
      throw new Error("temporary database not started");
    }
    return postgres.database;
  };
  const apply = async (from: number, through: number) => {
    const directory = fileURLToPath(new URL("../../../../database/v3/", import.meta.url));
    const catalog = await loadSqlCatalog(directory);
    await database().transaction(async (tx) => {
      for (const migration of catalog.slice(from - 1, through)) {
        await tx.query(migrationBody(migration));
      }
    });
  };

  it("preserves all 32 terminal/queued pairs and coalesces only duplicate active requests", async () => {
    const historical: QueueSeed[] = Array.from({ length: 32 }, (_, index) => [
      {
        listing: `historical-${index}`,
        state: index < 30 ? ("review" as const) : ("completed" as const),
      },
      { listing: `historical-${index}`, state: "queued" as const },
    ]).flat();
    await seedMigrationQueue(database(), [
      ...historical,
      { listing: "active-running", state: "queued" },
      { listing: "active-running", state: "running", createdAt: "2026-09-02T00:00:00Z" },
      { listing: "active-ready", state: "queued", createdAt: "2026-09-02T00:00:00Z" },
      { listing: "active-ready", state: "ready" },
      { listing: "active-tie", state: "queued" },
      { listing: "active-tie", state: "queued" },
    ]);
    await seedHistoricCapture(database());
    const before = await database().query(
      "SELECT to_jsonb(q) AS row FROM queue_item q WHERE listing_id LIKE 'historical-%' ORDER BY item_id",
    );
    const attempts = await database().query("SELECT * FROM queue_attempt ORDER BY run_id");
    await apply(39, 42);
    expect(
      await database().query(
        "SELECT to_jsonb(q) - 'follows_item_id' AS row FROM queue_item q WHERE listing_id LIKE 'historical-%' ORDER BY item_id",
      ),
    ).toEqual(before);
    expect(await database().query("SELECT * FROM queue_attempt ORDER BY run_id")).toEqual(attempts);
    await assertActiveLeaders(database());
    expect(
      await database().query(
        "SELECT operation_id, reused, credit_cost FROM html_capture ORDER BY operation_id",
      ),
    ).toEqual([
      { operation_id: "missing-owner", reused: false, credit_cost: null },
      { operation_id: "reused-original", reused: true, credit_cost: "0" },
    ]);
    await assertPermitGrants(database());
  });

  it("refuses two running owners atomically without rewriting their state or attempts", async () => {
    await seedMigrationQueue(database(), [
      { listing: "running-duplicate", state: "running" },
      { listing: "running-duplicate", state: "running" },
    ]);
    await apply(39, 39);
    const rows = await database().query("SELECT * FROM queue_item ORDER BY item_id");
    const attempts = await database().query("SELECT * FROM queue_attempt ORDER BY run_id");
    await expect(apply(40, 42)).rejects.toThrow("Drain duplicate running queue items");
    expect(await database().query("SELECT * FROM queue_item ORDER BY item_id")).toEqual(rows);
    expect(await database().query("SELECT * FROM queue_attempt ORDER BY run_id")).toEqual(attempts);
  });
});

async function assertActiveLeaders(database: TemporaryPostgres["database"]) {
  expect(
    await database.query(
      "SELECT listing_id, state FROM queue_item WHERE listing_id LIKE 'active-%' AND state <> 'following' ORDER BY listing_id",
    ),
  ).toEqual([
    { listing_id: "active-ready", state: "ready" },
    { listing_id: "active-running", state: "running" },
    { listing_id: "active-tie", state: "queued" },
  ]);
  expect(
    await database.query(`SELECT follower.listing_id FROM queue_item follower
    JOIN queue_item leader ON leader.item_id = follower.follows_item_id
    WHERE follower.state = 'following' AND follower.listing_id = leader.listing_id
      AND follower.run_id IS NULL ORDER BY follower.listing_id`),
  ).toEqual([
    { listing_id: "active-ready" },
    { listing_id: "active-running" },
    { listing_id: "active-tie" },
  ]);
  const ties = await database.query<{ state: string }>(
    "SELECT state FROM queue_item WHERE listing_id = 'active-tie' ORDER BY item_id",
  );
  expect(ties.map((row) => row.state)).toEqual(["queued", "following"]);
}

async function assertPermitGrants(database: TemporaryPostgres["database"]) {
  const tables = ["resource_permit_stop", "resource_permit_execution", "resource_permit_event"];
  const rows = await database.query<{ table_name: string; privilege_type: string }>(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
     WHERE grantee = 'v3_runtime' AND table_name = ANY($1::text[])`,
    [tables],
  );
  for (const table of tables) {
    expect(
      rows
        .filter((row) => row.table_name === table)
        .map((row) => row.privilege_type)
        .sort(),
    ).toEqual(
      table === "resource_permit_event" ? ["INSERT", "SELECT"] : ["INSERT", "SELECT", "UPDATE"],
    );
  }
}
