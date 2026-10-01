import { readFileSync } from "node:fs";
import type { Database } from "@crawl-automation/platform";
import type { AddToQueue } from "@crawl-automation/app";
import { expect, it, vi } from "vitest";
import { PostgresChannelQueueStore } from "./postgres-channel-queue-store.js";

const list: AddToQueue = {
  channel: "wholefoods",
  batchId: "batch-1",
  label: "scan",
  products: [
    {
      listingId: "B0096M5PBW",
      variantId: null,
      sourceId: "source",
      url: "https://example.test/item",
    },
  ],
};
function store(insertStates: string[]) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("count(*)::int AS found")) {
      return [{ found: 1 }];
    }
    if (sql.includes("INSERT INTO link_batch")) {
      return [{ batch_id: "batch" }];
    }
    if (sql.includes("INSERT INTO queue_item")) {
      return [{ state: insertStates.shift() }];
    }
    return [];
  });
  const database = {
    query,
    transaction: async (work: (tx: { query: typeof query }) => unknown) => work({ query }),
  } as unknown as Database;
  return { queue: new PostgresChannelQueueStore(database), query };
}

it("records both batch requests and reports database-coalesced followers separately", async () => {
  const fixture = store(["queued", "following"]);
  expect(await fixture.queue.add(list)).toEqual({ added: 1 });
  expect(await fixture.queue.add({ ...list, batchId: "batch-2" })).toEqual({
    added: 0,
    following: 1,
  });
  const inserts = fixture.query.mock.calls.filter(([sql]) =>
    sql.includes("INSERT INTO queue_item"),
  );
  expect(inserts).toHaveLength(2);
  expect(inserts.every(([sql]) => sql.includes("RETURNING item_id, state"))).toBe(true);
  expect(
    fixture.query.mock.calls.filter(([sql]) => sql.includes("pg_advisory_xact_lock")),
  ).toHaveLength(2);
});

it("permits explicit completed requeue without a saved-page-age restriction", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ state: "completed" }])
    .mockResolvedValueOnce([]);
  const database = {
    transaction: async (work: (tx: { query: typeof query }) => unknown) => work({ query }),
  } as unknown as Database;
  expect(
    await new PostgresChannelQueueStore(database).requeue({
      channel: "wholefoods",
      itemIds: ["a".repeat(64)],
    }),
  ).toEqual({ requeued: 1 });
  expect(query.mock.calls[2]?.[0]).toContain("state = 'queued', run_id = NULL");
  expect(query.mock.calls.map(([sql]) => sql).join(" ")).not.toMatch(
    /captured_at|interval|reuse_window/,
  );
});

// PostgreSQL runtime/concurrency coverage is a required deployment check, unavailable in this sandbox.
it("migration enforces cross-batch claims, preserved followers, and refuses hiding active duplicates", () => {
  const sql = readFileSync(
    new URL("../../../../database/v3/040_queue_followers_family_outcomes.sql", import.meta.url),
    "utf8",
  );
  expect(sql).toContain("CREATE UNIQUE INDEX queue_one_active_listing");
  expect(sql).toContain("ON queue_item(channel, listing_id, coalesce(variant_id, ''))");
  expect(sql).toContain("BEFORE INSERT OR UPDATE OF state ON queue_item");
  expect(sql).toContain("NEW.follows_item_id := leader");
  expect(sql).toContain("WHERE state = 'following' AND follows_item_id = NEW.item_id");
  expect(sql).toContain("Drain duplicate running queue items");
  expect(sql).not.toContain("DELETE FROM queue_attempt");
});
