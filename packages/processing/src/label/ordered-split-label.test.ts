import { expect, it, vi } from "vitest";
import { LabelReviewedImageRecordSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { orderedFixture } from "./ordered-fixture.js";
import {
  croppedPanel,
  factsPanel,
  ingredientsPanel,
  splitReview,
} from "../testing/split-label-fixture.js";
import { defined } from "../testing/defined.js";
import { orderedEvidence } from "./ordered-evidence.js";
import { mergeLabelProduct } from "../assembly/label-merge.js";
import { visionFingerprint } from "../testing/label-sources.js";
import type { LabelPlans } from "./label-plans.js";
import { OrderedProgressSchema } from "./ordered-model.js";
import { orderedProgressKey } from "./ordered-diagnostics.js";

async function fixture(conflict = false) {
  const last = ingredientsPanel();
  if (conflict && last.otherIngredients) {
    last.otherIngredients.items[0] = { text: "Soy", evidence: "Soy" };
  }
  const test = await orderedFixture({
    order: "text-first",
    candidates: [factsPanel(), croppedPanel(), factsPanel(), last],
  });
  const records = new Map<string, ReviewRecord>();
  for (const id of ["a-text", "source-1"]) {
    const review = splitReview(defined(test.tasks.get(id)));
    records.set(review.reviewId, review);
  }
  vi.mocked(test.inspection.review).mockImplementation(async (id) => records.get(id) ?? null);
  test.inspection.readReviewedImage = vi.fn(async ({ task, review }) => ({
    candidate: croppedPanel(),
    record: LabelReviewedImageRecordSchema.parse({
      codec: "vision-reviewed/1",
      ...task,
      review,
      result: defined(test.entries.get("source-1")).record.result,
    }),
  }));
  test.plans.source.mockImplementation(async (request) => ({
    input: request,
    status: request.sourceId === "source-0" ? "not_matched" : "prepared",
    source: test.tasks.get(request.sourceId),
  }));
  const states = [
    { id: "a-text", status: "review", reviewId: "review-a-text" },
    { id: "source-0", status: "not_matched" },
    { id: "source-1", status: "review", reviewId: "review-source-1" },
    { id: "source-2", status: "registered" },
    { id: "source-3", status: "registered" },
  ];
  return { ...test, records, request: OrderedProgressSchema.parse({ input: test.input, states }) };
}

it("combines the Costco sequence's facts and ingredients, keeping the printed source of each field", async () => {
  const test = await fixture();
  const signal = AbortSignal.timeout(5_000);
  for (let count = 1; count <= test.request.states.length; count++) {
    const request = { ...test.request, states: test.request.states.slice(0, count) };
    const check = await test.selection.inspect(request, signal);
    expect(check.complete).toBe(count === 5);
    expect(check.terminal).toBe(false);
    if (count >= 3) {
      expect(check.reason?.sourceId).not.toBe("a-text");
    }
  }
  const evidence = await orderedEvidence(
    test.plans as unknown as LabelPlans,
    { inspection: test.inspection, visionFingerprint },
    { request: test.request, signal },
  );
  const result = mergeLabelProduct(
    {
      operationId: test.input.operationId,
      observation: test.input.owner,
      evidencePolicy: "label-image-first/6",
      sources: evidence.sources,
    },
    evidence,
  );
  expect(result.status).toBe("ready");
  expect(result.formula?.servingSize?.sourceId).toBe("source-1");
  expect(result.otherIngredients?.heading.sourceId).toBe("source-3");
  expect(result.otherIngredients?.items.map((item) => item.text)).toEqual(["Cellulose", "Silica"]);
  expect(result.warnings).toContainEqual({ id: "a-text", code: "TEXT.LABEL_COVERAGE_UNCERTAIN" });
  expect(test.plans.publish).toHaveBeenLastCalledWith(
    orderedProgressKey(test.input, test.request.states),
    expect.objectContaining({
      outcomes: [
        expect.objectContaining({ sourceId: "a-text", code: "TEXT.LABEL_COVERAGE_UNCERTAIN" }),
        expect.objectContaining({ sourceId: "source-0", code: "CHANNEL.LABEL_NO_SOURCE" }),
        expect.objectContaining({
          sourceId: "source-1",
          code: "VISION.LABEL_INGREDIENTS_INCOMPLETE",
        }),
        expect.objectContaining({
          sourceId: "source-2",
          missing: ["LABEL.INGREDIENTS_INCOMPLETE"],
          evidenceKeys: [
            "v3/vision/label-source-2/response.json",
            "v3/vision/label-source-2/completion.json",
          ],
        }),
        expect.objectContaining({ sourceId: "source-3", missing: ["LABEL.FORMULA_INCOMPLETE"] }),
      ],
    }),
    signal,
  );
});

it("keeps a conflict in Review and names both overlapping sources", async () => {
  const test = await fixture(true);
  const check = await test.selection.inspect(test.request, AbortSignal.timeout(5_000));
  expect(check.complete).toBe(false);
  expect(check.reason?.code).toBe("LABEL_PRODUCT.INGREDIENTS_CONFLICT");
  expect(check.failures).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sourceId: "source-1", code: "LABEL_PRODUCT.INGREDIENTS_CONFLICT" }),
      expect.objectContaining({ sourceId: "source-3", code: "LABEL_PRODUCT.INGREDIENTS_CONFLICT" }),
    ]),
  );
  expect(check.failures).toContainEqual({
    sourceId: "source-2",
    code: "LABEL.INGREDIENTS_INCOMPLETE",
    executionFact: "executed",
  });
});

it("uses a reviewed facts section even without a registered facts duplicate", async () => {
  const test = await fixture();
  test.request.states.splice(3, 1);
  test.loaded.manifest.sources = test.loaded.manifest.sources.filter(
    (source) => source.id !== "source-2",
  );
  test.loaded.imageOrder = test.loaded.imageOrder.filter((id) => id !== "source-2");
  expect(await test.selection.inspect(test.request, AbortSignal.timeout(5_000))).toMatchObject({
    complete: true,
  });
});

it("stops unknown execution and refuses a missing reviewed original without calling models", async () => {
  const test = await fixture();
  defined(test.records.get("review-source-1")).failure.executionFact = "unknown";
  expect(await test.selection.inspect(test.request, AbortSignal.timeout(5_000))).toMatchObject({
    complete: false,
    terminal: true,
  });
  expect(test.inspection.readReviewedImage).not.toHaveBeenCalled();
  defined(test.records.get("review-source-1")).failure.executionFact = "executed";
  vi.mocked(defined(test.inspection.readReviewedImage)).mockRejectedValue(
    new Error("missing original"),
  );
  await expect(test.selection.inspect(test.request, AbortSignal.timeout(5_000))).rejects.toThrow(
    "missing original",
  );
});
