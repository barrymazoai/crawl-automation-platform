import { errorCodeOf } from "../errors/error-code.js";
import { createLogger } from "../logger/create-logger.js";

const log = createLogger({ name: "artifact-storage" });

/** Never log provider messages, paths, credentials or arbitrary error causes. */
export function logStorageRecovery(
  message: string,
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  log.debug({ ...context, code: errorCodeOf(error) }, message);
}
