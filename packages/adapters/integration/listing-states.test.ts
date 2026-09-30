import { execFileSync } from "node:child_process";
import { liveSighting, recordSighting } from "@crawl-automation/app";
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
    state: "unlisted",
    reason: "not_found",
    evidence: {
      probe: "direct-revisit",
      causeCode: "LISTING.NOT_FOUND",
      httpStatus: 404,
      observedExternalId: null,
      finalUrl: null,
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
    const different = {
      ...sighting(),
      observationId: first.observationId,
      state: "live" as const,
      reason: null,
    };
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

  it.each([
    ["an unlisted sighting without a reason", { reason: null }],
    ["a live sighting with a reason", { state: "live" }],
    [
      "a redirect to another product without that product",
      { reason: "redirected_to_other_product" },
    ],
    [
      "a missing page without a 404 or 410",
      { evidence: { ...sighting().evidence, httpStatus: 500 } },
    ],
  ])("the table itself refuses %s", async (_case, changes) => {
    const bad = sighting({ ...changes, source: "crawler-v3:product-run:gnc-2" });
    await expect(
      store.record({ ...(bad as never), observationId: "c".repeat(64) }),
    ).rejects.toThrow();
  });

  it("lists, counts and marks delivery", async () => {
    const redirected = await recordSighting(
      store,
      sighting({
        listingId: "877081",
        reason: "redirected_to_other_product",
        source: "crawler-v3:product-run:gnc-3",
        evidence: {
          ...sighting().evidence,
          causeCode: "LISTING.REDIRECTED_TO_OTHER_PRODUCT",
          observedExternalId: "999111",
          finalUrl: "https://www.gnc.com/product/999111.html",
          httpStatus: 200,
        },
      }),
    );
    expect(await store.list({ channel: "gnc", brandId, limit: 10 })).toHaveLength(2);
    expect(await store.counts({ channel: "gnc", brandId })).toEqual({
      channel: "gnc",
      byState: { unlisted: 2, live: 0 },
      byReason: {
        not_found: 1,
        redirected_to_other_product: 1,
        redirected_away: 0,
        identity_conflict: 0,
      },
      undelivered: 2,
    });
    await store.markDelivered([
      { observationId: redirected.observationId, status: "ok", response: { events: [] } },
    ]);
    const pending = await store.undelivered(10);
    expect(pending.map((row) => row.listingId)).toEqual(["877080"]);
    const delivered = await store.list({
      channel: "gnc",
      reason: "redirected_to_other_product",
      limit: 10,
    });
    expect(delivered[0]?.deliveredAt).not.toBeNull();
  });

  it("counts a captured page's live sighting", async () => {
    const request = {
      runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
      channel: "gnc" as const,
      url: "https://www.gnc.com/product/877082.html",
      brandId,
      sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      operationId: "gnc-4",
    };
    const page = {
      channel: "gnc" as const,
      url: request.url,
      listingId: "877082",
      variantId: null,
      externalId: "877082",
      capturedAt: "2026-09-29T12:00:00.000Z",
      commerce: null,
      archive: { objectKey: "v3/gnc-html/gnc-4/original.html", sha256: "a".repeat(64) },
    };
    await recordSighting(store, liveSighting(request, page));
    const counts = await store.counts({ channel: "gnc", brandId });
    expect(counts.byState.live).toBe(1);
    expect(await store.list({ channel: "gnc", state: "live", limit: 10 })).toMatchObject([
      { listingId: "877082", reason: null, evidence: { causeCode: "LISTING.LIVE" } },
    ]);
  });
});
