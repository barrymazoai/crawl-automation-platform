import type { SafeErrorSummary } from "@crawl-automation/platform/errors/summary";
import type { LabelRun } from "./label-run.js";

type Failure = {
  sourceId: string;
  code: string;
  executionFact: string;
  cause?: SafeErrorSummary;
};

/** Add causes only to Review data; source states, inspection inputs and primary codes stay unchanged. */
export function reviewFailureDetails(
  run: LabelRun,
  at: { failures?: Failure[]; primaryFailure?: Failure },
) {
  const withCause = (failure: Failure): Failure => {
    const cause = failure.cause ?? run.sourceCauses?.get(failure.sourceId);
    return { ...failure, ...(cause ? { cause } : {}) };
  };
  const failures = at.failures?.map(withCause) ?? [];
  for (const [sourceId, cause] of run.sourceCauses ?? []) {
    if (failures.length < 100 && !failures.some((failure) => failure.sourceId === sourceId)) {
      failures.push({
        sourceId,
        code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
        executionFact: "unknown",
        cause,
      });
    }
  }
  return {
    ...(at.failures || failures.length ? { failures } : {}),
    ...(at.primaryFailure ? { primaryFailure: withCause(at.primaryFailure) } : {}),
  };
}
