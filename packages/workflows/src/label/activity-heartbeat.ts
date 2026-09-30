import { withCause } from "@crawl-automation/platform/errors/activity";
import { activityCodes, activityErrors } from "@crawl-automation/platform/errors/activity";
import { ApplicationFailure, TimeoutFailure } from "@temporalio/workflow";

/** Inspect SDK timeout metadata, never the provider's message text. */
export function isHeartbeatTimeout(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    if (current instanceof TimeoutFailure && current.timeoutType === "HEARTBEAT") {
      return true;
    }
    if (isHeartbeatFailure(current)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** Only the patched activity caller creates this code; legacy timeouts keep legacy handling. */
export function isHeartbeatFailure(error: unknown): error is ApplicationFailure {
  return error instanceof ApplicationFailure && error.type === activityCodes.heartbeatTimeout;
}

/** Gives server-originated timeouts a registered code that existing Review readers understand. */
export async function withHeartbeatFailure<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    if (isHeartbeatTimeout(error)) {
      throw withCause(
        ApplicationFailure.nonRetryable(
          activityErrors.codes[activityCodes.heartbeatTimeout].message,
          activityCodes.heartbeatTimeout,
        ),
        error,
      );
    }
    throw error;
  }
}
