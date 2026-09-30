import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { AmazonLinkStore } from "./amazon-link-store.js";
import { AmazonLinkBatchSchema } from "./amazon-link-batches.js";
export function linkFixture() {
  return AmazonLinkBatchSchema.parse({ codec: "amazon-link-batch/1", requestId: randomUUID(),
    scope: { brandId: randomUUID(), sourceId: randomUUID(), channel: "amazon", region: "US", rootUrl: "https://www.amazon.com/", scopeVersion: "source-revision-2" },
    candidateManifestSha256: "a".repeat(64), entries: [{ candidateId: "b".repeat(64), historyListingId: "c".repeat(64),
      entry: { listingId: "B000REPUY0", variantId: null, kind: "product", url: "https://www.amazon.com/dp/B000REPUY0" } }] });
}
it("sees newly added batches without restarting and never caches a miss", async () => {
  const batch = linkFixture(); let record: unknown;
  const query = vi.fn(async () => ({ rows: record ? [{ record }] : [] }));
  const store = new AmazonLinkStore({ query } as any);
  expect(await store.get(batch.requestId)).toBeNull();
  record = batch; expect(await store.get(batch.requestId)).toEqual(batch);
  (await store.get(batch.requestId))!.entries.length = 0;
  expect(await store.get(batch.requestId)).toEqual(batch); expect(query).toHaveBeenCalledTimes(2);
});
it("falls back only on a missing row, refuses DB errors and conflicting legacy authorizations", async () => {
  const batch = linkFixture(), query = vi.fn(async () => ({ rows: [] as any[] })), store = new AmazonLinkStore({ query } as any, [batch]);
  expect(await store.get(batch.requestId)).toEqual(batch);
  query.mockRejectedValueOnce(Error("unavailable")); await expect(store.get(batch.requestId)).rejects.toThrow("unavailable");
  query.mockResolvedValueOnce({ rows: [{ record: { ...batch, candidateManifestSha256: "d".repeat(64) } }] });
  await expect(store.get(batch.requestId)).rejects.toThrow("IDENTITY_CONFLICT");
});
it("bounds positive cache and refuses a foreign request ID returned by storage", async () => {
  const a = linkFixture(), b = linkFixture(), rows = new Map([a, b].map(x => [x.requestId, x]));
  const query = vi.fn(async (_sql: string, args: string[]) => ({ rows: [{ record: rows.get(args[0]!) }] }));
  const store = new AmazonLinkStore({ query } as any, [], 1);
  await store.get(a.requestId); await store.get(b.requestId); await store.get(a.requestId); expect(query).toHaveBeenCalledTimes(3);
  await expect(store.get(randomUUID())).rejects.toThrow();
});
