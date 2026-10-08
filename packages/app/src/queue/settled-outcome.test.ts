import { describe, expect, it } from "vitest";
import { settledOutcome } from "./dispatch-model.js";

describe("settledOutcome remaining terminal and malformed cases", () => {
  it("settles a verified scope exclusion with its reason, not as a collected formula", () => {
    const result = {
      status: "scope-excluded",
      operationId: "product-scope",
      listingId: "offer",
      variantId: null,
      reason: "DTC.MULTI_PRODUCT_BUNDLE",
      policy: "dtc-product-scope/1",
      evidence: { objectKey: "scope/result.json", sha256: "a".repeat(64), byteSize: 120 },
    };
    expect(settledOutcome({ status: "COMPLETED", result })).toEqual({
      state: "completed",
      reason: "DTC.MULTI_PRODUCT_BUNDLE",
    });
    expect(settledOutcome({ status: "COMPLETED", result: { ...result, evidence: null } })).toEqual({
      state: "review",
      reason: "QUEUE.OUTCOME_UNRECOGNIZED",
    });
  });
  it("completes a product its store files outside supplements (owner 2026-10-08)", () => {
    const result = {
      status: "not-supplement",
      operationId: "product-1",
      listingId: "B0GF3DSQCJ",
      variantId: null,
      reason: "PRODUCT.NOT_SUPPLEMENT",
      policy: "store-category/1",
      categories: ["Baby Products", "Diapering"],
      reviewCode: "CHANNEL.LABEL_NO_SOURCE",
    };
    expect(settledOutcome({ status: "COMPLETED", result })).toEqual({
      state: "completed",
      reason: "PRODUCT.NOT_SUPPLEMENT",
    });
    expect(settledOutcome({ status: "COMPLETED", result: { ...result, categories: [] } })).toEqual({
      state: "review",
      reason: "QUEUE.OUTCOME_UNRECOGNIZED",
    });
  });

  it.each([
    ["FAILED", "QUEUE.RUN_FAILED"],
    ["TERMINATED", "QUEUE.RUN_TERMINATED"],
  ])("keeps %s as a Review even when a stale result says collected", (status, reason) => {
    expect(settledOutcome({ status, result: { status: "collected" } })).toEqual({
      state: "review",
      reason,
    });
  });

  it.each([null, undefined, [], {}, "collected", { status: 1 }, { status: "review", code: 12 }])(
    "refuses malformed completed results: %j",
    (result) => {
      expect(settledOutcome({ status: "COMPLETED", result })).toEqual({
        state: "review",
        reason: "QUEUE.OUTCOME_UNRECOGNIZED",
      });
    },
  );

  it.each([
    [{ code: "SOURCE.GONE", codes: ["OTHER"] }, "SOURCE.GONE"],
    [{ codes: ["LABEL.MISSING", "LABEL.PARTIAL"] }, "LABEL.MISSING"],
    [{ codes: [] }, "QUEUE.RUN_REVIEW"],
    [{}, "QUEUE.RUN_REVIEW"],
  ])("uses the explicit code, first assembly code or fallback: %j", (fields, reason) => {
    const result = { status: "review", ...fields };
    expect(settledOutcome({ status: "COMPLETED", result })).toEqual({ state: "review", reason });
  });

  it("does not settle an unrecognized workflow status", () => {
    expect(settledOutcome({ status: "CONTINUED_AS_NEW", result: null })).toBeNull();
  });

  it.each(["metrics-complete", "formula-pending", "no-amazon-source", "formula-linked"])(
    "settles execution with a separate %s business outcome",
    (status) => {
      expect(settledOutcome({ status: "COMPLETED", result: { status } })).toEqual({
        state: "completed",
        reason: null,
      });
    },
  );
  it("records an in-flight follower as pending, never a Review or completed label", () => {
    expect(
      settledOutcome({
        status: "COMPLETED",
        result: { status: "pending", code: "CAPTURE.IN_FLIGHT" },
      }),
    ).toEqual({ state: "pending", reason: "CAPTURE.IN_FLIGHT" });
  });
});
