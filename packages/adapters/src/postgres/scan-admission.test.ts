import { createHash } from "node:crypto";
import type { AddToQueue } from "@crawl-automation/app";
import type { Database, Queryable } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import { PostgresChannelQueueStore } from "./postgres-channel-queue-store.js";

const input: AddToQueue = {
  channel: "wholefoods",
  batchId: "batch",
  label: "scan",
  products: [
    { sourceId: "source", url: "https://example.test/one", listingId: "one", variantId: null },
  ],
};
const policy = { recentScanSkipHours: 24 };
const counts = { added: 1, following: 2, recent: 70 };
const record_hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

function fixture() {
  const query = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ found: 1 }]);
  const transaction = vi.fn(async (work: (tx: Queryable) => Promise<unknown>) => work({ query }));
  const database = { query: vi.fn(), transaction } as unknown as Database;
  return { query, transaction, database, store: new PostgresChannelQueueStore(database) };
}

it("locks and commits discoveries with their counts on the same transaction connection", async () => {
  const test = fixture();
  test.query.mockResolvedValueOnce([{ batch_id: input.batchId }]).mockResolvedValueOnce([counts]);
  expect(await test.store.add(input, policy)).toEqual(counts);
  expect(test.transaction).toHaveBeenCalledOnce();
  expect(test.database.query).not.toHaveBeenCalled();
  expect(test.query.mock.calls[0]).toEqual([
    expect.stringContaining("pg_advisory_xact_lock"),
    [73110325, "wholefoods"],
  ]);
  expect(test.query.mock.calls[3]).toEqual([
    expect.stringContaining("INSERT INTO queue_scan_admission"),
    [input.channel, input.batchId, expect.any(String), 24],
  ]);
});

it("counts repeated cards as one SKU and keeps its first URL/source", async () => {
  const test = fixture();
  test.query.mockResolvedValueOnce([{ batch_id: input.batchId }]).mockResolvedValueOnce([counts]);
  const first = input.products[0];
  if (!first) {
    throw new Error("missing product");
  }
  await test.store.add(
    { ...input, products: [first, { ...first, url: `${first.url}?duplicate` }] },
    policy,
  );
  const rows = JSON.parse(test.query.mock.calls[3]?.[1][2] as string);
  expect(rows).toEqual([expect.objectContaining({ listing_id: first.listingId, url: first.url })]);
});

it("replays saved counts after the batch commits, without another item insertion", async () => {
  const test = fixture();
  test.query
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ record_hash }])
    .mockResolvedValueOnce([counts]);
  expect(await test.store.add(input, policy)).toEqual(counts);
  expect(test.query.mock.calls.map(([sql]) => sql).join("\n")).not.toContain(
    "INSERT INTO queue_item",
  );
});

it("never reapplies admission to a historical batch without a receipt", async () => {
  const test = fixture();
  test.query
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ record_hash }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ added: 2, following: 1, recent: 0 }]);
  expect(await test.store.add(input, policy)).toEqual({ added: 2, following: 1, recent: 0 });
  expect(test.query.mock.calls.at(-1)?.[0]).toContain("follows_item_id IS NOT NULL");
  expect(test.query.mock.calls.map(([sql]) => sql).join("\n")).not.toContain(
    "INSERT INTO queue_item",
  );
});

it("refuses changed content under the same batch identity before returning a receipt", async () => {
  const test = fixture();
  test.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ record_hash: "different" }]);
  await expect(test.store.add(input, policy)).rejects.toMatchObject({
    code: "QUEUE.IMPORT_CONFLICT",
  });
  expect(test.query).toHaveBeenCalledTimes(4);
});

it("propagates admission failure to the transaction without retrying", async () => {
  const test = fixture();
  const failure = new Error("receipt failed");
  test.query.mockResolvedValueOnce([{ batch_id: input.batchId }]).mockRejectedValueOnce(failure);
  await expect(test.store.add(input, policy)).rejects.toBe(failure);
  expect(test.transaction).toHaveBeenCalledOnce();
  expect(test.query).toHaveBeenCalledTimes(4);
});
