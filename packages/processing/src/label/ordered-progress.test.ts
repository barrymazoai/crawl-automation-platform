import { expect, it } from "vitest";
import { primaryOrderedFailure } from "./ordered-progress.js";

const noLabel = {
  failure: {
    sourceId: "image",
    code: "CHANNEL.LABEL_NO_SOURCE",
    executionFact: "executed",
  },
  progress: 4,
  index: 1,
};

function failed(code: string, progress = 1) {
  return { failure: { sourceId: "page", code, executionFact: "executed" }, progress, index: 0 };
}

it.each([
  "TEXT.LABEL_INGREDIENT_ROLE_INVALID",
  "TEXT.LABEL_PARENT_INVALID",
  "TEXT.CITATION_INVALID",
  "TEXT.LABEL_COVERAGE_UNCERTAIN",
  "FILE.TIMEOUT",
])("/2 prefers %s over a further-progressed empty source", (code) => {
  const failure = failed(code);
  const ranked = [failure, noLabel];
  expect(primaryOrderedFailure("source-failure-first/2", ranked)).toEqual(failure.failure);
  expect(primaryOrderedFailure("source-failure-first/2", [...ranked].reverse())).toEqual(
    failure.failure,
  );
  expect(ranked).toEqual([failure, noLabel]);
});

it.each([undefined, "source-failure-first/1"] as const)(
  "%s still ranks progress first",
  (policy) => {
    expect(primaryOrderedFailure(policy, [failed("TEXT.CITATION_INVALID"), noLabel])).toEqual(
      noLabel.failure,
    );
  },
);

it("/1 retains its real-failure tie-break while unversioned tasks keep the latest source", () => {
  const failure = failed("TEXT.CITATION_INVALID", noLabel.progress);
  expect(primaryOrderedFailure("source-failure-first/1", [failure, noLabel])).toEqual(
    failure.failure,
  );
  expect(primaryOrderedFailure(undefined, [failure, noLabel])).toEqual(noLabel.failure);
});

it("/2 keeps progress and source order as tie-breaks within real failures", () => {
  const early = failed("FILE.TIMEOUT");
  const further = failed("TEXT.CITATION_INVALID", 3);
  const later = { ...further, failure: { ...further.failure, sourceId: "later" }, index: 2 };
  expect(primaryOrderedFailure("source-failure-first/2", [early, further, noLabel])).toEqual(
    further.failure,
  );
  expect(primaryOrderedFailure("source-failure-first/2", [early, further, later])).toEqual(
    later.failure,
  );
});

it("/2 retains no-source when there is no real failure, and handles an empty list", () => {
  expect(primaryOrderedFailure("source-failure-first/2", [noLabel])).toEqual(noLabel.failure);
  expect(primaryOrderedFailure("source-failure-first/2", [])).toBeUndefined();
});

it("ranks an image proven to lack a label below a real error, and summarizes its sole failure as no source", () => {
  const emptyReview = {
    failure: {
      sourceId: "front",
      code: "VISION.LABEL_INGREDIENTS_INCOMPLETE",
      executionFact: "executed",
    },
    progress: 4,
    index: 2,
    noLabel: true,
  };
  const real = failed("VISION.LABEL_AMOUNT_STATE_CONFLICT");
  expect(primaryOrderedFailure("source-failure-first/2", [emptyReview, real])).toEqual(
    real.failure,
  );
  expect(primaryOrderedFailure(undefined, [emptyReview, real])).toEqual(real.failure);
  expect(primaryOrderedFailure("source-failure-first/2", [emptyReview])).toEqual({
    ...emptyReview.failure,
    code: "CHANNEL.LABEL_NO_SOURCE",
  });
});
