import { expect, it } from "vitest";
import { labelCandidate, imageSource } from "../testing/label-sources.js";
import { noSourceSummary, type DiagnosedOrderedEvidence } from "./ordered-source-outcome.js";
import { sourceStateDiagnostic } from "./ordered-source-state.js";

function evidence(): DiagnosedOrderedEvidence {
  return { sources: [], entries: [], failures: [], reasons: [], terminal: false };
}

it("keeps the source medium, parser skip reason, unsupported media and unattempted sources", () => {
  const result = noSourceSummary({
    ...evidence(),
    sourceDiagnostics: [
      sourceStateDiagnostic({ id: "page", kind: "page" }, undefined, false),
      sourceStateDiagnostic(
        { id: "parsed", kind: "page" },
        { id: "parsed", status: "not_matched", reason: "LABEL_CORE.SOURCE_UNSUPPORTED" },
      ),
      sourceStateDiagnostic({ id: "image", kind: "file-image" }, undefined),
      sourceStateDiagnostic({ id: "pdf", kind: "pdf-text" }, undefined),
    ],
  });
  expect(result).toEqual({
    total: 4,
    omitted: 0,
    sources: [
      {
        sourceId: "page",
        kind: "page",
        status: "not_started",
        reason: "skipped",
        detail: "no_label_section",
      },
      {
        sourceId: "parsed",
        kind: "page",
        status: "not_matched",
        reason: "skipped",
        detail: "LABEL_CORE.SOURCE_UNSUPPORTED",
      },
      { sourceId: "image", kind: "image", status: "not_started", reason: "not_attempted" },
      {
        sourceId: "pdf",
        kind: "text",
        status: "not_started",
        reason: "unsupported_media",
        detail: "pdf-text",
      },
    ],
  });
});

it("uses a retained model answer for no-label detail without inventing a product classification", () => {
  const candidate = labelCandidate();
  candidate.formula = null;
  candidate.otherIngredients = null;
  candidate.issues = [
    { code: "FORMULA_MISSING", detail: "Only the front of the bottle is visible." },
  ];
  const source = imageSource(candidate, 0);
  const result = noSourceSummary({
    ...evidence(),
    entries: [source.entry],
    sourceDiagnostics: [
      sourceStateDiagnostic(
        { id: source.entry.id, kind: "file-image" },
        { id: source.entry.id, status: "registered" },
      ),
    ],
  });
  expect(result.sources).toEqual([
    {
      sourceId: source.entry.id,
      kind: "image",
      status: "registered",
      reason: "model_no_label",
      detail: "Only the front of the bottle is visible.",
    },
  ]);
});

it("caps the source list and every free-text field and records the omitted count", () => {
  const source = {
    sourceId: "i".repeat(10_000),
    kind: "image" as const,
    status: "s".repeat(10_000),
    reason: "r".repeat(10_000),
    detail: "d".repeat(10_000),
    matchedKeywords: Array.from({ length: 50 }, () => "k".repeat(10_000)),
  };
  const result = noSourceSummary({
    ...evidence(),
    sourceDiagnostics: Array.from({ length: 100 }, () => source),
  });
  expect(result.total).toBe(100);
  expect(result.omitted).toBe(80);
  expect(result.sources).toHaveLength(20);
  expect(result.sources[0]).toEqual({
    sourceId: "i".repeat(128),
    kind: "image",
    status: "s".repeat(24),
    reason: "r".repeat(120),
    detail: "d".repeat(240),
    matchedKeywords: Array.from({ length: 6 }, () => "k".repeat(48)),
  });
  expect(JSON.stringify(result).length).toBeLessThan(20_000);
  expect(source.sourceId).toHaveLength(10_000);
  expect(source.matchedKeywords).toHaveLength(50);
});
