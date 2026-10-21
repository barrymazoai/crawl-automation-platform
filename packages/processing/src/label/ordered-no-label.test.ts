import { expect, it, vi } from "vitest";
import { labelCandidate } from "../testing/label-sources.js";
import { splitReview } from "../testing/split-label-fixture.js";
import { defined } from "../testing/defined.js";
import { imageReviewWithoutLabel } from "../assembly/source-without-label.js";
import { orderedFixture } from "./ordered-fixture.js";

const signal = () => AbortSignal.timeout(5_000);
const reviewState = (id: string) => ({ id, status: "review" as const, reviewId: `review-${id}` });
const registered = (id: string) => ({ id, status: "registered" as const });

function emptyImage() {
  const candidate = labelCandidate();
  candidate.formula = null;
  candidate.otherIngredients = null;
  candidate.formulaComplete = false;
  candidate.ingredientsComplete = false;
  candidate.issues = [
    { code: "FORMULA_MISSING", detail: "No Facts panel is visible." },
    { code: "INGREDIENTS_MISSING", detail: "Only the front of the bottle is visible." },
  ];
  return candidate;
}

async function reviewedWalk(first = emptyImage(), second = labelCandidate()) {
  const fixture = await orderedFixture({ pageHasLabelSection: false, candidates: [first, second] });
  const review = splitReview(defined(fixture.tasks.get("source-0")), first);
  vi.mocked(fixture.inspection.review).mockResolvedValue(review);
  const input = { ...fixture.input, failurePolicy: "source-failure-first/2" as const };
  return { ...fixture, input, review };
}

it("keeps a real reviewed label failure ahead of the remaining images", async () => {
  const label = labelCandidate();
  label.issues = [{ code: "UNREADABLE", detail: "The amount is obscured." }];
  const fixture = await reviewedWalk(label);
  fixture.review.failure.code = "VISION.LABEL_AMOUNT_STATE_CONFLICT";
  const check = await fixture.selection.inspect(
    { input: fixture.input, states: [reviewState("source-0")] },
    signal(),
  );
  expect(check).toMatchObject({
    complete: false,
    terminal: true,
    reason: { code: "VISION.LABEL_AMOUNT_STATE_CONFLICT" },
  });
});

it("stops at a conflicting twelfth image, but walks on when that image is only a front panel", async () => {
  const fixture = await orderedFixture({
    pageHasLabelSection: false,
    candidates: Array.from({ length: 13 }, () => labelCandidate()),
  });
  const review = splitReview(defined(fixture.tasks.get("source-11")), labelCandidate());
  review.failure.code = "VISION.LABEL_AMOUNT_STATE_CONFLICT";
  vi.mocked(fixture.inspection.review).mockResolvedValue(review);
  fixture.plans.source.mockImplementation(async (request) => ({
    input: request,
    status: Number(request.sourceId.slice(7)) < 11 ? "not_matched" : "prepared",
    source: fixture.tasks.get(request.sourceId),
  }));
  const input = { ...fixture.input, failurePolicy: "source-failure-first/2" as const };
  const states = [
    ...Array.from({ length: 11 }, (_, index) => ({
      id: `source-${index}`,
      status: "not_matched" as const,
    })),
    reviewState("source-11"),
  ];
  expect(await fixture.selection.inspect({ input, states }, signal())).toMatchObject({
    terminal: true,
    reason: { code: "VISION.LABEL_AMOUNT_STATE_CONFLICT" },
  });
  expect(fixture.plans.source.mock.calls.some(([call]) => call.sourceId === "source-12")).toBe(
    false,
  );
  review.failure.code = "VISION.LABEL_INGREDIENTS_INCOMPLETE";
  review.candidate = {
    schema: "label-extraction/1",
    value: JSON.parse(JSON.stringify(emptyImage())),
  };
  expect(await fixture.selection.inspect({ input, states }, signal())).toMatchObject({
    terminal: false,
    reason: { code: "CHANNEL.LABEL_NO_SOURCE" },
  });
  expect(
    await fixture.selection.inspect(
      { input, states: [...states, registered("source-12")] },
      signal(),
    ),
  ).toMatchObject({ complete: true, terminal: false });
});

it("continues past a reviewed front image to the next complete label and retains its diagnosis", async () => {
  const fixture = await reviewedWalk();
  const first = await fixture.selection.inspect(
    { input: fixture.input, states: [reviewState("source-0")] },
    signal(),
  );
  expect(first).toMatchObject({
    complete: false,
    terminal: false,
    reason: { code: "CHANNEL.LABEL_NO_SOURCE" },
  });
  const later = await fixture.selection.inspect(
    { input: fixture.input, states: [reviewState("source-0"), registered("source-1")] },
    signal(),
  );
  expect(later).toMatchObject({ complete: true, terminal: false });
  await fixture.selection.manifest(
    {
      input: fixture.input,
      selectedImageId: null,
      states: [
        reviewState("source-0"),
        registered("source-1"),
        { id: "a-text", status: "not_started" },
      ],
    },
    signal(),
  );
  expect(fixture.plans.publishManifest).toHaveBeenCalledWith(
    expect.objectContaining({
      sources: [fixture.tasks.get("source-1")],
      skipped: ["source-0", "a-text"],
    }),
    expect.any(AbortSignal),
  );
  expect(fixture.plans.publish).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      decisions: expect.arrayContaining([
        { id: "source-0", action: "skipped", reason: "model_no_label" },
      ]),
    }),
    expect.any(AbortSignal),
  );
  expect(fixture.plans.publish).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      outcomes: [
        expect.objectContaining({
          code: "VISION.LABEL_INGREDIENTS_INCOMPLETE",
          evidenceKeys: [fixture.review.failure.evidenceKey],
        }),
        expect.objectContaining({ sourceId: "source-1" }),
      ],
      sourceDiagnostics: expect.arrayContaining([
        expect.objectContaining({ sourceId: "source-0", reason: "model_no_label" }),
      ]),
    }),
    expect.any(AbortSignal),
  );
});

it("reports no source when every reviewed image lacks both sections, with each reason retained", async () => {
  const fixture = await reviewedWalk(emptyImage(), emptyImage());
  const second = splitReview(defined(fixture.tasks.get("source-1")), emptyImage());
  vi.mocked(fixture.inspection.review).mockImplementation(async (id) =>
    id === fixture.review.reviewId ? fixture.review : id === second.reviewId ? second : null,
  );
  const check = await fixture.selection.inspect(
    { input: fixture.input, states: [reviewState("source-0"), reviewState("source-1")] },
    signal(),
  );
  expect(check).toMatchObject({
    complete: false,
    terminal: false,
    reason: { code: "CHANNEL.LABEL_NO_SOURCE" },
  });
  expect(fixture.plans.publish).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({
      sourceDiagnostics: expect.arrayContaining([
        expect.objectContaining({ sourceId: "source-0", reason: "model_no_label" }),
        expect.objectContaining({ sourceId: "source-1", reason: "model_no_label" }),
      ]),
      sourceOutcomes: expect.objectContaining({
        sources: expect.arrayContaining([
          expect.objectContaining({ sourceId: "source-0", reason: "model_no_label" }),
          expect.objectContaining({ sourceId: "source-1", reason: "model_no_label" }),
        ]),
      }),
    }),
    expect.any(AbortSignal),
  );
});

it("does not classify unreadable, partial, or contradictory answers as absent labels", () => {
  const empty = emptyImage();
  const failure = {
    id: "source-0",
    code: "VISION.LABEL_INGREDIENTS_INCOMPLETE",
    candidate: empty,
    verifiedExecuted: true,
  };
  expect(imageReviewWithoutLabel(failure)).toBe(true);
  expect(imageReviewWithoutLabel({ ...failure, verifiedExecuted: false })).toBe(false);
  expect(
    imageReviewWithoutLabel({
      ...failure,
      candidate: {
        ...empty,
        issues: [...empty.issues, { code: "UNREADABLE", detail: "Blurred." }],
      },
    }),
  ).toBe(false);
  expect(imageReviewWithoutLabel({ ...failure, candidate: labelCandidate() })).toBe(false);
  expect(
    imageReviewWithoutLabel({
      ...failure,
      code: "VISION.LABEL_CORE_MISSING",
      candidate: { ...empty, issues: [] },
    }),
  ).toBe(true);
});

it("reuses a verified no-label Review without re-reading the model answer", async () => {
  const fixture = await reviewedWalk();
  const first = { input: fixture.input, states: [reviewState("source-0")] };
  await fixture.selection.inspect(first, signal());
  const record = defined(fixture.plans.publish.mock.lastCall?.[1]);
  Object.assign(fixture.plans, { read: vi.fn(async () => Buffer.from(JSON.stringify(record))) });
  vi.mocked(fixture.inspection.review).mockClear();
  const next = await fixture.selection.inspect(
    { input: fixture.input, states: [...first.states, registered("source-1")] },
    signal(),
  );
  expect(next).toMatchObject({ complete: true });
  const reused = defined(fixture.plans.publish.mock.lastCall?.[1]);
  expect(reused.outcomes[0]).toEqual(record.outcomes[0]);
  expect(fixture.inspection.review).not.toHaveBeenCalled();
  expect(fixture.plans.source.mock.calls.map(([call]) => call.sourceId)).toEqual([
    "source-0",
    "source-1",
  ]);
});
