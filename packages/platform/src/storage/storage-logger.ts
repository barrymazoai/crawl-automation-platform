import { describeCodexError } from "../codex/error-detail.js";
import { platformErrors } from "../errors/platform-errors.js";
import { errorCodeOf } from "../errors/error-code.js";
import { createLogger } from "../logger/create-logger.js";
import { currentMeasurement } from "../logging/measurement-context.js";

const log = createLogger({ name: "artifact-storage" });

/** Never log provider messages, paths, credentials or arbitrary error causes. */
export function logStorageRecovery(
  message: string,
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  const code = errorCodeOf(error) ?? platformErrors.code("RUNTIME.RECOVERY_FAILED");
  log.warn(
    {
      runId: null,
      ...currentMeasurement()?.identity,
      ...context,
      code,
      outcomeCode: code,
      reason: describeCodexError(error),
    },
    message,
  );
}
