import { errorCodeOf, type Logger } from "@crawl-automation/platform";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";

type Handler = (raw: unknown, signal: AbortSignal) => Promise<unknown>;

const HEARTBEAT_MS = 2_000;

/**
 * Runs one activity the pipeline's way: only the first attempt may run (paid and model work is never retried),
 * it heartbeats while it works, and any failure leaves as a non-retryable failure carrying the error's code.
 */
export function guarded(name: string, handler: Handler, log: Logger) {
  return async (raw: unknown): Promise<unknown> => {
    const context = Context.current();
    if (context.info.attempt !== 1) {
      throw ApplicationFailure.nonRetryable("Automatic retry denied", "PIPELINE.RETRY_DENIED");
    }
    const timer = setInterval(() => context.heartbeat(), HEARTBEAT_MS);
    try {
      return await handler(raw, context.cancellationSignal);
    } catch (error) {
      context.cancellationSignal.throwIfAborted();
      const code = errorCodeOf(error) ?? "PIPELINE.ACTIVITY_UNRESOLVED";
      log.error({ activity: name, code, err: error }, "activity failed");
      throw ApplicationFailure.nonRetryable(`${name} failed`, code);
    } finally {
      clearInterval(timer);
    }
  };
}
