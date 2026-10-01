import { errorCodeOf } from "@crawl-automation/platform";

export function codedFailure(error: unknown): unknown {
  if (!error || typeof error !== "object") {
    return error;
  }
  let reason: unknown = error;
  for (let depth = 0; reason && depth < 8; depth++) {
    const failure = reason as { type?: string; cause?: unknown };
    const code = errorCodeOf(reason) ?? errorCodeOf({ code: failure.type });
    if (code) {
      return Object.assign(error, { code });
    }
    reason = failure.cause;
  }
  return error;
}
