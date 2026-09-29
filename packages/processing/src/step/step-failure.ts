import { errorCodeOf, type AppError, type RaiseOptions } from "@crawl-automation/platform";

/** Whether the service ran before a failure: decides whether a Review may say "not executed". */
export type ExecutionFact = "not_executed" | "executed" | "unknown";

interface ErrorList<Code extends string> {
  create(code: Code, options?: RaiseOptions): AppError;
}

/**
 * A step failure from an area's error list. It records whether the service had already run and, when another error
 * caused it, that error's code (or name), so the Review keeps the real reason.
 */
export function stepFailure<Code extends string>(
  errors: ErrorList<Code>,
  code: Code,
  options: { fact?: ExecutionFact; cause?: unknown } = {},
): AppError {
  const { fact = "unknown", cause } = options;
  const causeCode = cause === undefined ? null : (errorCodeOf(cause) ?? errorName(cause));
  return errors.create(code, {
    details: { executionFact: fact, ...(causeCode ? { cause: causeCode } : {}) },
    ...(cause === undefined ? {} : { cause }),
  });
}

function errorName(error: unknown): string | null {
  return error instanceof Error ? error.name : null;
}

/** The execution fact a step failure recorded; null when it recorded none. */
export function recordedFact(error: AppError): ExecutionFact | null {
  const fact = error.details["executionFact"];
  return fact === "not_executed" || fact === "executed" || fact === "unknown" ? fact : null;
}
