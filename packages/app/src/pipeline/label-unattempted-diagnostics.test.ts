import { expect, it, vi } from "vitest";
import type { ReviewRecord } from "@crawl-automation/v3-contracts";
// Exercise the same retained plan shape as processing's ordered inspector.
// eslint-disable-next-line no-restricted-imports
import { orderedFixture } from "../../../processing/src/label/ordered-fixture.js";
import { LabelReviews } from "./label-reviews.js";
import { labelReviewDiagnostics } from "./label-review-diagnostics.js";

const signal = () => AbortSignal.timeout(5_000);
async function setup() {
  const fixture = await orderedFixture({ candidates: [], pageHasLabelSection: false });
  fixture.input.failurePolicy = "source-failure-first/2";
  const states = fixture.loaded.manifest.sources.map((source) => ({
    id: source.id,
    status: "not_started",
  }));
  const plans = { inspect: vi.fn(async () => fixture.loaded) };
  const objects = { read: vi.fn(async (): Promise<Uint8Array | null> => null) };
  const at = { input: fixture.input, states, code: "CHANNEL.LABEL_NO_SOURCE", plans };
  return { ...fixture, at, plans, objects };
}

it("writes the zero-attempt source summary inside the existing Review activity", async () => {
  const test = await setup();
  const rows = new Map<string, ReviewRecord>();
  const reviews = {
    read: vi.fn(async (id: string) => rows.get(id) ?? null),
    append: vi.fn(async (record: ReviewRecord) => {
      rows.set(record.reviewId, record);
    }),
  };
  const evidence = { publish: vi.fn(async () => undefined) };
  const service = new LabelReviews({
    reviews,
    evidence,
    diagnostics: test.objects,
    plans: test.plans,
  });
  const request = { input: test.input, code: test.at.code, states: test.at.states };
  const result = await service.review(request, signal());
  expect(result).toMatchObject({
    status: "review",
    code: "CHANNEL.LABEL_NO_SOURCE",
    automaticRetry: false,
  });
  const summary = {
    total: 2,
    omitted: 0,
    sources: [
      {
        sourceId: "a-text",
        kind: "page",
        status: "not_started",
        reason: "skipped",
        detail: "no_label_section",
      },
      { sourceId: "images", kind: "image", status: "not_started", reason: "none_eligible" },
    ],
  };
  expect(rows.get(result.reviewId)?.rawError.details).toEqual({
    input: test.input,
    states: test.at.states,
    sourceOutcomes: summary,
  });
  expect(JSON.stringify(summary).length).toBeLessThan(500);
  expect(test.plans.inspect).toHaveBeenCalledExactlyOnceWith(
    test.input.plan,
    expect.any(AbortSignal),
  );
  expect(evidence.publish).toHaveBeenCalledOnce();
  expect(reviews.append).toHaveBeenCalledOnce();
  expect(await service.review(request, signal())).toEqual(result);
  expect(test.plans.inspect).toHaveBeenCalledOnce();
  expect(evidence.publish).toHaveBeenCalledOnce();
});

it.each(["attempted", "preparation_failure"])(
  "does not infer zero-attempt outcomes for %s Reviews",
  async (kind) => {
    const test = await setup();
    if (kind === "attempted") {
      test.at.states = [{ id: "a-text", status: "unresolved" }];
    } else {
      test.at.code = "CHANNEL.LABEL_PREPARATION_UNVERIFIED";
    }
    expect(await labelReviewDiagnostics(test.objects, test.at, signal())).toEqual({});
    expect(test.plans.inspect).not.toHaveBeenCalled();
  },
);

it.each([undefined, "source-failure-first/1", "source-failure-first/2"] as const)(
  "diagnoses an unrecorded zero-attempt Review independently of failure ranking policy %s",
  async (policy) => {
    const test = await setup();
    test.input.failurePolicy = policy;
    expect(await labelReviewDiagnostics(test.objects, test.at, signal())).toHaveProperty(
      "sourceOutcomes",
    );
  },
);

it.each(["owner", "operation", "source", "duplicate"])(
  "leaves out the summary for a retained plan with mismatched %s identity",
  async (kind) => {
    const test = await setup();
    if (kind === "owner") {
      test.loaded.manifest.observation = { ...test.input.owner, observationId: "foreign" };
    } else if (kind === "operation") {
      test.loaded.manifest.operationId = "foreign";
    } else if (kind === "source") {
      test.at.states = [{ id: "foreign", status: "not_started" }];
    } else {
      test.at.states.push(...test.at.states);
    }
    // Diagnostics never stop the Review: a summary that cannot be proven is left out.
    expect(await labelReviewDiagnostics(test.objects, test.at, signal())).not.toHaveProperty(
      "sourceOutcomes",
    );
  },
);

it("a failing plan lookup leaves the summary out instead of failing the Review", async () => {
  const test = await setup();
  test.plans.inspect.mockRejectedValue(new Error("plan store unavailable"));

  expect(await labelReviewDiagnostics(test.objects, test.at, signal())).not.toHaveProperty(
    "sourceOutcomes",
  );
});

it.each(["page", "image"])(
  "does not claim no eligible sources when a retained %s is eligible",
  async (kind) => {
    const test = await setup();
    if (kind === "page") {
      test.loaded.labelPreparation.pageHasLabelSection = true;
    } else {
      const withImages = await orderedFixture({ pageHasLabelSection: false });
      test.loaded.manifest.sources = withImages.loaded.manifest.sources;
      test.at.states = test.loaded.manifest.sources.map((source) => ({
        id: source.id,
        status: "not_started",
      }));
    }
    expect(await labelReviewDiagnostics(test.objects, test.at, signal())).toEqual({});
  },
);

it("bounds and redacts a large zero-attempt summary while retaining the image aggregate", async () => {
  const test = await setup();
  const page = test.loaded.manifest.sources[0];
  if (!page) {
    throw new Error("Missing page fixture");
  }
  test.loaded.manifest.sources = Array.from({ length: 25 }, (_, index) => ({
    ...page,
    id: index === 0 ? "a".repeat(80) : `page-${index}`,
  }));
  test.at.states = test.loaded.manifest.sources.map((source) => ({
    id: source.id,
    status: "not_started",
  }));
  const result = await labelReviewDiagnostics(test.objects, test.at, signal());
  expect(result).toMatchObject({
    sourceOutcomes: { total: 26, omitted: 6, sources: expect.any(Array) },
  });
  expect(result.sourceOutcomes?.sources).toHaveLength(20);
  expect(result.sourceOutcomes?.sources[0]?.sourceId).toBe("[data]");
  expect(result.sourceOutcomes?.sources.at(-1)?.reason).toBe("none_eligible");
  expect(JSON.stringify(result).length).toBeLessThan(3000);
});
