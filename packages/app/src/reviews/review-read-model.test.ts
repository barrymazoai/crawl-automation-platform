import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { publicReview } from "./public-review.js";
import { inspectReview } from "./review-inspection.js";

function stored(inspection: ReviewRecord["inspection"]): ReviewRecord {
  const requestId = "req-pub-1";
  const observationId = "obs-pub-1";
  return {
    schemaVersion: 1,
    reviewId: "review-pub-1",
    occurredAt: "2026-09-30T08:00:00.000Z",
    failure: {
      ...{ schemaVersion: 1, requestId, observationId, operationId: "op-pub-1" },
      ...{ inputFingerprint: "e".repeat(64), stage: "codex.text/run", category: "PROCESSING" },
      ...{ code: "TEXT.OUTPUT_LIMIT", executionFact: "executed", blockedBy: null },
      ...{ evidenceKey: "evidence/op-pub-1/text.json", automaticRetry: false },
    },
    observation: null,
    rawError: { name: "TextError", message: "hidden", stack: "stack-canary", details: {} },
    candidate: { schema: "product-candidate/1", value: { note: "value-canary" } },
    inspection,
  } as ReviewRecord;
}

describe("the Review read model", () => {
  it("shows only allowlisted fields; raw error and candidate appear as hashes", () => {
    const shown = JSON.stringify(
      publicReview(stored({ kind: "none" }), "2026-09-30T08:00:01.000Z"),
    );
    expect(shown).toContain("TEXT.OUTPUT_LIMIT");
    expect(shown).not.toContain("canary");
    expect(shown).not.toContain("hidden");
  });

  it("inspects read-only: no target is not applicable, a named target is not configured", () => {
    const at = new Date("2026-09-30T09:00:00.000Z");
    expect(inspectReview(stored({ kind: "none" }), at)).toEqual({
      reviewId: "review-pub-1",
      observedAt: "2026-09-30T09:00:00.000Z",
      mutatesState: false,
      automaticRetry: false,
      status: "NOT_APPLICABLE",
    });
    const named = stored({ kind: "workflow-delivery", requestId: "req-pub-1" });
    expect(inspectReview(named, at)).toMatchObject({ status: "NOT_CONFIGURED" });
  });
});
