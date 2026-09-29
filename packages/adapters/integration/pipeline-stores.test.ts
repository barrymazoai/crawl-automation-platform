import { execFileSync } from "node:child_process";
import type { Database } from "@crawl-automation/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresExecutionRegistry } from "../src/postgres/postgres-execution-registry.js";
import { PostgresFormulaIndex } from "../src/postgres/postgres-formula-index.js";
import { PostgresProductRunStore } from "../src/postgres/postgres-product-run-store.js";
import { findRun, listRuns } from "../src/postgres/run-queries.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";

const hasPostgres = (() => {
  try {
    execFileSync("initdb", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

const runId = "11111111-1111-4111-8111-111111111111";
const url = "https://www.swansonvitamins.com/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr";

describe.skipIf(!hasPostgres)("pipeline stores against a real PostgreSQL", () => {
  let postgres: TemporaryPostgres;
  let database: Database;
  let brandId: string;
  let sourceId: string;

  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    database = postgres.database;
    const brands = await database.query<{ id: string }>(
      "INSERT INTO brand (name) VALUES ('Healthy Origins') RETURNING id",
    );
    brandId = brands[0]?.id ?? "";
    const sources = await database.query<{ id: string }>(
      "INSERT INTO brand_source (brand_id, channel, url) VALUES ($1, 'swanson', $2) RETURNING id",
      [brandId, "https://www.swansonvitamins.com/collections/brand-healthy-origins"],
    );
    sourceId = sources[0]?.id ?? "";
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  it("accepts a product run once, refuses a different one under the same ID, and records its start once", async () => {
    const store = new PostgresProductRunStore(database);
    const source = await store.source(sourceId);
    expect(source).toEqual({ brandId, channel: "swanson" });
    const run = {
      kind: "product" as const,
      requestId: runId,
      sourceId,
      url,
      brandId,
      channel: "swanson" as const,
    };

    const accepted = await store.accept(run);
    expect(accepted).toMatchObject({
      runId,
      workflowId: `product-run-${runId}`,
      startedRunId: null,
    });
    expect(await store.accept(run)).toEqual(accepted);
    await expect(store.accept({ ...run, url: `${url}?variant=1` })).rejects.toMatchObject({
      code: "REQUEST.ID_CONFLICT",
    });

    await store.markStarted(runId, "temporal-run-1");
    await store.markStarted(runId, "temporal-run-2");
    expect((await store.accept(run)).startedRunId).toBe("temporal-run-1");
  });

  it("lists and finds product runs with brand runs", async () => {
    const found = await findRun(database, runId);
    expect(found).toMatchObject({
      kind: "product",
      url,
      brandName: "Healthy Origins",
      guardHeld: false,
    });
    const listed = await listRuns(database, { channel: "swanson", brandId, limit: 10 });
    expect(listed.map((run) => run.runId)).toContain(runId);
    expect(await listRuns(database, { active: true, limit: 10 })).toEqual([]);
    expect(await findRun(database, "99999999-9999-4999-8999-999999999999")).toBeNull();
  });

  it("finds no known formula for a product never collected", async () => {
    const index = new PostgresFormulaIndex(database);

    expect(
      await index.findKnown({ channels: ["swanson"], listingId: "123", variantId: "456" }),
    ).toBeNull();
    expect(
      await index.findKnown({ channels: ["swanson"], listingId: "123", variantId: null }),
    ).toBeNull();
  });

  it("links an observation to one execution and refuses a second one", async () => {
    const registry = new PostgresExecutionRegistry(database);
    const execution = { clusterId: "c", namespace: "n", workflowId: "w", runId: "r" };

    await registry.register("swanson-observation", execution);
    await registry.register("swanson-observation", execution);
    await expect(
      registry.register("swanson-observation", { ...execution, runId: "other" }),
    ).rejects.toMatchObject({ code: "PIPELINE.EXECUTION_CONFLICT" });
  });
});
