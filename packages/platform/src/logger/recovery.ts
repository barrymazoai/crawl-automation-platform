import { errorCodeOf } from "../errors/error-code.js";
import { platformErrors } from "../errors/platform-errors.js";
import { createLogger } from "./create-logger.js";
import { currentMeasurement } from "../logging/measurement-context.js";

const log = createLogger({ name: "recovery" });

/** A fallback may continue, but its original failure must remain observable. */
export function recordRecovery(error: unknown, context: Record<string, unknown>): void {
  const code = errorCodeOf(error) ?? platformErrors.code("RUNTIME.RECOVERY_FAILED");
  log.warn(
    {
      runId: null,
      ...currentMeasurement()?.identity,
      ...context,
      code,
      outcomeCode: code,
      err: error,
    },
    "Operation failed; recovery continues",
  );
}
