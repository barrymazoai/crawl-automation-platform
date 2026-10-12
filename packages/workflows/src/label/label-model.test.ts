import { expect, it } from "vitest";
// Compare the workflow-safe mirror against the activity schema; neither imports the other at runtime.
/* eslint-disable no-restricted-imports */
import { LabelPlanInputSchema } from "../../../processing/src/label/label-plan-model.js";
import { SourceOutcomesSchema } from "@crawl-automation/v3-contracts";
/* eslint-enable no-restricted-imports */
import { LabelTaskSchema } from "./label-model.js";
import { LabelProgressSchema } from "./label-ordered-model.js";
import { entry } from "./label-fixture.js";

it.each([undefined, "source-failure-first/1", "source-failure-first/2"])(
  "workflow and activity inputs both retain policy %s",
  (failurePolicy) => {
    const input = { ...entry.input, ...(failurePolicy ? { failurePolicy } : {}) };
    expect(LabelTaskSchema.parse(input)).toEqual(input);
    expect(LabelPlanInputSchema.parse(input)).toEqual(input);
  },
);

const progress = { input: {}, complete: false, terminal: false };
const source = { sourceId: "image", kind: "image", status: "not_matched", reason: "no_text" };
const summary = { total: 1, omitted: 0, sources: [source] };

it("the strict workflow progress mirror accepts old replies and the optional bounded summary", () => {
  expect(LabelProgressSchema.parse(progress)).toEqual(progress);
  expect(LabelProgressSchema.parse({ ...progress, sourceOutcomes: summary })).toEqual({
    ...progress,
    sourceOutcomes: SourceOutcomesSchema.parse(summary),
  });
  expect(LabelProgressSchema.safeParse({ ...progress, unexpected: true }).success).toBe(false);
});

it.each([
  { total: 21, omitted: 0, sources: Array.from({ length: 21 }, () => source) },
  { ...summary, sources: [{ ...source, detail: "x".repeat(241) }] },
  { ...summary, sources: [{ ...source, sourceId: "x".repeat(129) }] },
  {
    ...summary,
    sources: [{ ...source, matchedKeywords: Array.from({ length: 7 }, () => "Facts") }],
  },
  { ...summary, sources: [{ ...source, matchedKeywords: ["x".repeat(49)] }] },
])("both diagnostic schemas refuse oversized Review data", (sourceOutcomes) => {
  expect(SourceOutcomesSchema.safeParse(sourceOutcomes).success).toBe(false);
  expect(LabelProgressSchema.safeParse({ ...progress, sourceOutcomes }).success).toBe(false);
});
