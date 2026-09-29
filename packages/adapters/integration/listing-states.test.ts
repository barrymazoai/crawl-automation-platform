import { execFileSync } from "node:child_process";
import { recordSighting } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresListingStates } from "../src/postgres/postgres-listing-states.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";

const hasPostgres = (() => {
  try {
    execFileSync("initdb", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

const brandId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function sighting(changes: Record<string, unknown> = {}) {
  return {
    channel: "gnc",
    listingId: "877080",
    variantId: null,
    brandId,
    runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
    state: "gone",
    evidence: {
      probe: "direct-revisit",
      causeCode: "CAPTURE.NOT_FOUND",
      httpStatus: 404,
      observedExternalId: null,
      artifactKey: null,
    },
    source: "crawler-v3:product-run:gnc-1",
    capturedAt: "2026-09-29T10:00:00.000Z",
    ...changes,
  };
}

describe.skipIf(!hasPostgres)("listing states against a real PostgreSQL", () => {
  let postgres: TemporaryPostgres;
  let database: Database;
  let store: PostgresListingStates;

  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    database = postgres.database;
    store = new PostgresListingStates(database);
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  it("records once, keeps the first record, and refuses a different sighting under the same key", async () => {
    const first = await recordSighting(store, sighting());
    const again = await recordSighting(store, sighting({ capturedAt: "2026-09-29T11:00:00.000Z" }));
    expect(again).toEqual(first);
    const different = { ...sighting(), observationId: first.observationId, state: "live" as const };
    await expect(store.record(different as never)).rejects.toMatchObject({
      code: "LISTING.OBSERVATION_CONFLICT",
    });
  });

  it("never lets a stored sighting change or disappear", async () => {
    await expect(
      database.query("UPDATE listing_state_observation SET state = 'live'"),
    ).rejects.toThrow();
    await expect(database.query("DELETE FROM listing_state_observation")).rejects.toThrow();
  });

  it("refuses a superseded sighting without the listing it became, in the table itself", async () => {
    const bad = { ...sighting({ state: "superseded", source: "crawler-v3:product-run:gnc-2" }) };
    await expect(
      store.record({ ...(bad as never), observationId: "c".repeat(64) }),
    ).rejects.toThrow();
  });

  it("lists, counts and marks delivery", async () => {
    const superseded = await recordSighting(
      store,
      sighting({
        listingId: "877081",
        state: "superseded",
        source: "crawler-v3:product-run:gnc-3",
        evidence: { ...sighting().evidence, observedExternalId: "999111", httpStatus: 200 },
      }),
    );
    expect(await store.list({ channel: "gnc", brandId, limit: 10 })).toHaveLength(2);
    expect(await store.counts({ channel: "gnc", brandId })).toEqual({
      channel: "gnc",
      byState: { gone: 1, superseded: 1, live: 0 },
      undelivered: 2,
    });
    await store.markDelivered([
      { observationId: superseded.observationId, status: "ok", response: { events: [] } },
    ]);
    const pending = await store.undelivered(10);
    expect(pending.map((row) => row.listingId)).toEqual(["877080"]);
    const delivered = await store.list({ channel: "gnc", state: "superseded", limit: 10 });
    expect(delivered[0]?.deliveredAt).not.toBeNull();
  });
});
