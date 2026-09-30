import { describe, expect, it } from "vitest";
import { reviewFixture } from "../testing/review-fixture.js";
import { inspectRegistration } from "./review-ledger.js";
import {
  canonicalJson,
  MAX_REVIEW_BYTES,
  parseReviewRecord,
  reviewDigest,
} from "./review-record.js";

describe("Review records", () => {
  it("parses a complete record unchanged", () => {
    const record = reviewFixture();
    expect(parseReviewRecord(record)).toEqual(record);
  });

  it("hashes the same regardless of key order, and differently when the record changes", () => {
    expect(reviewDigest({ b: 2, a: 1 })).toBe(reviewDigest({ a: 1, b: 2 }));
    expect(reviewDigest(reviewFixture())).not.toBe(
      reviewDigest({ ...reviewFixture(), candidate: null }),
    );
  });

  it("refuses lossy, cyclic and oversized records instead of dropping parts", () => {
    for (const value of [undefined, NaN, Infinity, new Date(), { x: undefined }, [undefined]]) {
      expect(() => canonicalJson(value)).toThrow();
    }
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => canonicalJson(cycle)).toThrow(
      expect.objectContaining({ code: "REVIEW.INVALID_RECORD" }),
    );
    const large = reviewFixture();
    large.rawError.message = "x".repeat(MAX_REVIEW_BYTES);
    expect(() => parseReviewRecord(large)).toThrow(
      expect.objectContaining({ code: "REVIEW.TOO_LARGE" }),
    );
    const { candidate: _candidate, ...missing } = reviewFixture();
    expect(() => parseReviewRecord(missing)).toThrow(
      expect.objectContaining({ code: "REVIEW.INVALID_RECORD" }),
    );
  });
});

describe("inspectRegistration after an append whose answer was lost", () => {
  it("tells an exact, a missing and a conflicting stored Review apart", async () => {
    const record = reviewFixture();
    expect(await inspectRegistration({ read: async () => record }, record)).toMatchObject({
      registered: true,
    });
    expect(await inspectRegistration({ read: async () => null }, record)).toMatchObject({
      registered: false,
    });
    const other = { ...record, candidate: null };
    await expect(inspectRegistration({ read: async () => other }, record)).rejects.toMatchObject({
      code: "REVIEW.CONFLICT",
    });
  });
});
