import { expect, it } from "vitest";
import { orderedFixture } from "./ordered-fixture.js";
import { orderedEvidence } from "./ordered-evidence.js";
import { orderedProgress } from "./ordered-progress.js";
import type { LabelPlans } from "./label-plans.js";
import { OrderedProgressSchema } from "./ordered-model.js";
import { visionFingerprint } from "../testing/label-sources.js";

it.each([undefined, "no_text"] as const)(
  "a true /2 no-source result diagnoses all planned sources (empty text: %s)",
  async (reason) => {
    const fixture = await orderedFixture({ pageHasLabelSection: false });
    fixture.plans.source.mockImplementation(async (request) => ({
      input: request,
      status: "not_matched",
      source: undefined,
      ...(reason ? { reason } : {}),
    }));
    const request = OrderedProgressSchema.parse({
      input: { ...fixture.input, failurePolicy: "source-failure-first/1" },
      states: [{ id: "source-0", status: "not_matched" }],
    });
    const evidence = await orderedEvidence(
      fixture.plans as unknown as LabelPlans,
      { inspection: fixture.inspection, visionFingerprint },
      { request, signal: AbortSignal.timeout(5_000) },
    );
    const result = orderedProgress(
      { ...request, input: { ...request.input, failurePolicy: "source-failure-first/2" } },
      evidence,
      1,
    );
    expect(result).toMatchObject({
      complete: false,
      terminal: false,
      reason: { code: "CHANNEL.LABEL_NO_SOURCE" },
      sourceOutcomes: {
        total: 3,
        omitted: 0,
        sources: [
          {
            sourceId: "a-text",
            kind: "page",
            status: "not_started",
            reason: "skipped",
            detail: "no_label_section",
          },
          {
            sourceId: "source-0",
            kind: "image",
            status: "not_matched",
            reason: reason ?? "keyword_screen_missed",
            matchedKeywords: [],
          },
          { sourceId: "source-1", kind: "image", status: "not_started", reason: "not_attempted" },
        ],
      },
    });
    const { sourceOutcomes: _summary, ...legacy } = result;
    expect(orderedProgress(request, evidence, 1)).toEqual(legacy);
    expect(fixture.inspection.readSource).not.toHaveBeenCalled();
  },
);

it("does not add a no-source summary or change completion for a complete label", async () => {
  const fixture = await orderedFixture();
  const request = OrderedProgressSchema.parse({
    input: fixture.input,
    states: [{ id: "source-0", status: "registered" }],
  });
  const evidence = await orderedEvidence(
    fixture.plans as unknown as LabelPlans,
    { inspection: fixture.inspection, visionFingerprint },
    { request, signal: AbortSignal.timeout(5_000) },
  );
  const result = orderedProgress(
    { ...request, input: { ...request.input, failurePolicy: "source-failure-first/2" } },
    evidence,
    1,
  );
  expect(result.complete).toBe(true);
  expect(result).not.toHaveProperty("sourceOutcomes");
  expect(result).toEqual(orderedProgress(request, evidence, 1));
});

it("retains the PDF skip reason while still verifying the file and source", async () => {
  const fixture = await orderedFixture({ pageHasLabelSection: false });
  fixture.plans.source.mockImplementation(async (request) => ({
    input: request,
    status: "not_matched",
    source: undefined,
  }));
  const request = OrderedProgressSchema.parse({
    input: { ...fixture.input, failurePolicy: "source-failure-first/2" },
    states: [{ id: "source-0", status: "not_matched", reason: "pdf" }],
  });
  const read = () =>
    orderedEvidence(
      fixture.plans as unknown as LabelPlans,
      { inspection: fixture.inspection, visionFingerprint },
      { request, signal: AbortSignal.timeout(5_000) },
    );
  const result = orderedProgress(request, await read(), 1);
  expect(result.sourceOutcomes?.sources[1]).toEqual({
    sourceId: "source-0",
    kind: "image",
    status: "not_matched",
    reason: "skipped",
    detail: "pdf",
  });
  expect(fixture.inspection.file).toHaveBeenCalledOnce();
  expect(fixture.plans.source).toHaveBeenCalledOnce();
  fixture.plans.source.mockRejectedValue(new Error("Retained source unavailable"));
  await expect(read()).rejects.toThrow("Retained source unavailable");
});
