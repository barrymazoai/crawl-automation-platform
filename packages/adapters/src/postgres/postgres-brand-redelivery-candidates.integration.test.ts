import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import { PostgresBrandRedeliveryCandidates } from "./postgres-brand-redelivery-candidates.js";

const connectionString = process.env["CRAWL_TEST_DATABASE_URL"];
const cutoff = new Date("2026-09-09T00:00:00Z");
let client: Client;
let repository: PostgresBrandRedeliveryCandidates;

describe.skipIf(!connectionString)("brand product redelivery selection", () => {
  beforeEach(async () => {
    client = new Client({ connectionString });
    await client.connect();
    const schema = `brand_redelivery_${randomUUID().replaceAll("-", "")}`;
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path = ${schema}`);
    await client.query(`
      CREATE TABLE brand_enrichment_run(id uuid PRIMARY KEY, state text, updated_at timestamptz);
      CREATE TABLE brand_enrichment_step(run_id uuid, step text, output jsonb, created_at timestamptz,
        PRIMARY KEY(run_id, step));
      CREATE TABLE queue_item(source_id uuid, channel text, state text, updated_at timestamptz);`);
    const query: Queryable["query"] = async (sql, values) =>
      (await client.query(sql, [...(values ?? [])])).rows;
    repository = new PostgresBrandRedeliveryCandidates({ query });
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  it("selects a run once for multiple newly completed items and sources", async () => {
    const run = await seed();
    const other = await seed();
    await client.query(
      "INSERT INTO queue_item VALUES ($1, 'dtc', 'completed', $3), ($2, 'dtc', 'completed', $3)",
      [run.sourceId, run.secondSourceId, "2026-10-09T00:00:00Z"],
    );
    const result = await repository.findPending(cutoff);
    expect(result.sort()).toEqual([run.runId, other.runId].sort());
  });

  it.each(["running", "review", "queued"])("ignores %s items", async (itemState) => {
    await seed({ itemState });
    expect(await repository.findPending(cutoff)).toEqual([]);
  });

  it.each(["running", "failed", "cancelled", "waiting_for_person"])(
    "ignores %s brand runs",
    async (state) => {
      await seed({ state });
      expect(await repository.findPending(cutoff)).toEqual([]);
    },
  );

  it.each(["2026-10-06T00:00:00Z", "2026-10-07T00:00:00Z"])(
    "ignores completion at or before the last delivery: %s",
    async (completedAt) => {
      await seed({ completedAt });
      expect(await repository.findPending(cutoff)).toEqual([]);
    },
  );

  it.each([1, 2, 10])("uses the latest attempt %s and its delivery time", async (attempt) => {
    const { runId, sourceId } = await seed();
    if (attempt > 1) {
      await client.query("UPDATE brand_enrichment_step SET step = step || $2 WHERE run_id = $1", [
        runId,
        `@${attempt}`,
      ]);
    }
    for (const time of ["2026-10-08T00:00:00Z", "2026-10-07T12:00:00Z"]) {
      await client.query("INSERT INTO brand_enrichment_step VALUES ($1, $2, $3, $4)", [
        runId,
        `products-redelivery-${time}`,
        { attempt },
        time,
      ]);
    }
    expect(await repository.findPending(cutoff)).toEqual([]);
    await client.query("UPDATE queue_item SET updated_at = $1 WHERE source_id = $2", [
      "2026-10-08T00:00:01Z",
      sourceId,
    ]);
    expect(await repository.findPending(cutoff)).toEqual([runId]);
  });

  it("does not miss items completing between the delivery snapshot and its saved receipt", async () => {
    const { runId } = await seed();
    await client.query("INSERT INTO brand_enrichment_step VALUES ($1, $2, $3, $4)", [
      runId,
      "products-redelivery-concurrent",
      { deliveryStartedAt: "2026-10-07T12:00:00Z" },
      "2026-10-09T00:00:00Z",
    ]);
    expect(await repository.findPending(cutoff)).toEqual([runId]);
    await client.query("INSERT INTO brand_enrichment_step VALUES ($1, $2, $3, $4)", [
      runId,
      "products-redelivery-caught-up",
      { deliveryStartedAt: "2026-10-09T00:00:00Z" },
      "2026-10-09T00:01:00Z",
    ]);
    expect(await repository.findPending(cutoff)).toEqual([]);
  });

  it.each([1, 2])("requires saved sources for the latest attempt %s", async (attempt) => {
    const { runId } = await seed();
    if (attempt > 1) {
      await client.query(
        "INSERT INTO brand_enrichment_step VALUES ($1, 'products-retry@2', '{}', now())",
        [runId],
      );
    }
    await client.query("DELETE FROM brand_enrichment_step WHERE run_id = $1 AND step = $2", [
      runId,
      attempt === 1 ? "product-sources" : `product-sources@${attempt}`,
    ]);
    expect(await repository.findPending(cutoff)).toEqual([]);
  });

  it("delivers completed items when the original run closed before its first delivery", async () => {
    const { runId } = await seed();
    await client.query(
      "DELETE FROM brand_enrichment_step WHERE run_id = $1 AND step = 'products'",
      [runId],
    );
    expect(await repository.findPending(cutoff)).toEqual([runId]);
  });

  it("ignores absent or empty tasks, unrelated sources, and other channels", async () => {
    await seed({ channel: "amazon" });
    await seed({ queueSourceId: randomUUID() });
    for (const output of [{}, { tasks: [] }]) {
      const { runId } = await seed();
      await client.query(
        "UPDATE brand_enrichment_step SET output = $1 WHERE run_id = $2 AND step = 'product-sources'",
        [output, runId],
      );
    }
    expect(await repository.findPending(cutoff)).toEqual([]);
  });

  it("limits by completion date, including the cutoff but excluding older runs", async () => {
    await seed({ closedAt: "2026-09-08T23:59:59Z" });
    const included = await seed({ closedAt: cutoff.toISOString() });
    expect(await repository.findPending(cutoff)).toEqual([included.runId]);
  });
});

async function seed(
  overrides: Partial<{
    state: string;
    closedAt: string;
    itemState: string;
    completedAt: string;
    channel: string;
    queueSourceId: string;
  }> = {},
) {
  const runId = randomUUID();
  const sourceId = randomUUID();
  const secondSourceId = randomUUID();
  const row = {
    state: "completed",
    closedAt: "2026-10-07T01:00:00Z",
    itemState: "completed",
    completedAt: "2026-10-08T00:00:00Z",
    channel: "dtc",
    queueSourceId: sourceId,
    ...overrides,
  };
  await client.query("INSERT INTO brand_enrichment_run VALUES ($1, $2, $3)", [
    runId,
    row.state,
    row.closedAt,
  ]);
  await client.query(
    "INSERT INTO brand_enrichment_step VALUES ($1, 'product-sources', $2, $3), ($1, 'products', '{}', $4)",
    [
      runId,
      { tasks: [{ sourceId }, { sourceId: secondSourceId }] },
      "2026-10-06T00:00:00Z",
      "2026-10-07T00:00:00Z",
    ],
  );
  await client.query("INSERT INTO queue_item VALUES ($1, $2, $3, $4)", [
    row.queueSourceId,
    row.channel,
    row.itemState,
    row.completedAt,
  ]);
  return { runId, sourceId, secondSourceId };
}
