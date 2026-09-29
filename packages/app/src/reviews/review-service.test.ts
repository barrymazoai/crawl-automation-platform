import { describe, expect, it, vi } from "vitest";
import { ReviewService, type ReviewStore } from "./review-service.js";

function storeWith(review: unknown): ReviewStore {
  return { list: vi.fn(), summary: vi.fn(), inspect: vi.fn(), find: vi.fn(async () => review) };
}

describe("ReviewService.get", () => {
  it("returns a stored review", async () => {
    const service = new ReviewService({ reviews: storeWith({ reviewId: "r1" }) });

    await expect(service.get("r1")).resolves.toEqual({ reviewId: "r1" });
  });

  it("reports a missing review by code", async () => {
    const service = new ReviewService({ reviews: storeWith(null) });

    await expect(service.get("r9")).rejects.toMatchObject({ code: "REVIEW.NOT_FOUND" });
  });
});
