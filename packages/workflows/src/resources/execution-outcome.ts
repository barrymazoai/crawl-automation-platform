import { ApplicationFailure } from "@temporalio/workflow";
import { resourceGateCodes } from "@crawl-automation/platform/errors/resource-gate";

interface Outcome {
  name?: unknown;
  code?: unknown;
  type?: unknown;
  executionFact?: unknown;
  cleanup?: { stopped?: unknown };
  details?: unknown;
  cause?: unknown;
}

function unresolved(outcome: Outcome): boolean {
  return (
    outcome.name === "TimeoutFailure" ||
    outcome.name === "CancelledFailure" ||
    outcome.code === resourceGateCodes.cleanupUnverified ||
    outcome.type === resourceGateCodes.cleanupUnverified ||
    outcome.executionFact === "unknown" ||
    outcome.cleanup?.stopped === false
  );
}

/** Inspect structured facts, including serialized ActivityFailure causes; never error messages. */
export function needsStopProof(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const outcome = value as Outcome;
  return (
    unresolved(outcome) ||
    needsStopProof(outcome.cause) ||
    (Array.isArray(outcome.details)
      ? outcome.details.some(needsStopProof)
      : needsStopProof(outcome.details))
  );
}

/** An executed application failure is known; a missing/transport outcome remains unknown. */
export function unknownExecutionFailure(error: unknown): boolean {
  if (needsStopProof(error)) {
    return true;
  }
  if (error instanceof ApplicationFailure) {
    return false;
  }
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause === undefined || unknownExecutionFailure(cause);
}
