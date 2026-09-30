import { describe, expect, it } from "vitest";
import { MemoryStore } from "../testing/memory-store.js";
import { reviewFixture } from "../testing/review-fixture.js";
import { RemoteReviews } from "./remote-reviews.js";
import { reviewDigest } from "./review-record.js";

describe("RemoteReviews: Review objects kept by a worker without ledger access", () => {
  it("keeps a Review under a fixed key and reads the exact record back", async () => {
    const store = new MemoryStore();
    const reviews = new RemoteReviews(store);
    const record = reviewFixture("review-cloud-1");
    expect(await reviews.append(record)).toEqual({
      reviewId: "review-cloud-1",
      recordHash: reviewDigest(record),
      registered: true,
    });
    expect(await reviews.read("review-cloud-1")).toEqual(record);
    expect(await reviews.read("review-missing")).toBeNull();
  });

  it("refuses a different record under the same ID", async () => {
    const reviews = new RemoteReviews(new MemoryStore());
    const record = reviewFixture("review-cloud-2");
    await reviews.append(record);
    expect((await reviews.append(record)).registered).toBe(true);
    const changed = { ...record, occurredAt: "2026-09-07T00:00:00.000Z" };
    await expect(reviews.append(changed)).rejects.toMatchObject({ code: "REVIEW.CONFLICT" });
  });

  it("reports a tampered object as an integrity failure", async () => {
    const store = new MemoryStore();
    const reviews = new RemoteReviews(store);
    const record = reviewFixture("review-cloud-3");
    const bytes = Buffer.from(JSON.stringify({ ...record, reviewId: "review-other" }));
    await store.create(reviews.key("review-cloud-3"), bytes);
    await expect(reviews.read("review-cloud-3")).rejects.toMatchObject({
      code: "REVIEW.INTEGRITY",
    });
  });
});
