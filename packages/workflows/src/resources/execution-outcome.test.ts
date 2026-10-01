import {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  RetryState,
  TimeoutFailure,
  TimeoutType,
} from "@temporalio/common";
import { expect, it } from "vitest";
import { needsStopProof, unknownExecutionFailure } from "./execution-outcome.js";

function activityFailure(cause: Error) {
  return new ActivityFailure(
    "activity failed",
    "work",
    "permit",
    RetryState.NON_RETRYABLE_FAILURE,
    "worker",
    cause,
  );
}

it.each([TimeoutType.START_TO_CLOSE, TimeoutType.HEARTBEAT, TimeoutType.SCHEDULE_TO_CLOSE])(
  "requires proof for SDK activity timeout %s",
  (type) => {
    const failure = activityFailure(new TimeoutFailure("timed out", null, type));
    expect(unknownExecutionFailure(failure)).toBe(true);
  },
);

it("requires proof for cancellation, missing answers and pending cleanup", () => {
  expect(unknownExecutionFailure(activityFailure(new CancelledFailure("cancelled")))).toBe(true);
  expect(unknownExecutionFailure(new Error("lost answer"))).toBe(true);
  expect(needsStopProof({ status: "review", cleanup: { stopped: false } })).toBe(true);
});

it.each(["executed", "not_executed"])("preserves a known %s failure", (executionFact) => {
  const failure = ApplicationFailure.nonRetryable("known", "OCR.INVALID_INPUT", { executionFact });
  expect(unknownExecutionFailure(activityFailure(failure))).toBe(false);
});

it("reads unknown execution facts from serialized application details", () => {
  const failure = ApplicationFailure.nonRetryable("lost", "OCR.RESPONSE_UNKNOWN", {
    executionFact: "unknown",
    cleanup: { stopped: false },
  });
  expect(unknownExecutionFailure(activityFailure(failure))).toBe(true);
});

it("detects a pending journal in a release failure without matching its message", () => {
  const failure = ApplicationFailure.nonRetryable("arbitrary", "RESOURCE.CLEANUP_UNVERIFIED");
  expect(needsStopProof(activityFailure(failure))).toBe(true);
  expect(needsStopProof(new Error("RESOURCE.CLEANUP_UNVERIFIED"))).toBe(false);
  expect(needsStopProof({ status: "review" })).toBe(false);
});
