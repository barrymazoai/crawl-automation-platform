import { errorCodeOf, type Logger } from "@crawl-automation/platform";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { activityLogger } from "./activity-log.js";

type Handler = (raw: unknown, signal: AbortSignal) => Promise<unknown>;

const HEARTBEAT_MS = 2_000;

/**
 * Runs one activity the pipeline's way: only the first attempt may run (paid and model work is never retried),
 * it heartbeats while it works, it logs its start, end and failure with the run's IDs, and any failure leaves as a
 * non-retryable failure carrying the error's code.
 */
export function guarded(name: string, handler: Handler, log: Logger) {
  return async (raw: unknown): Promise<unknown> => {
    const context = Context.current();
    const activityLog = activityLogger(log, name, raw);
    if (context.info.attempt !== 1) {
      activityLog.warn({ attempt: context.info.attempt }, "activity retry denied");
      throw ApplicationFailure.nonRetryable("Automatic retry denied", "PIPELINE.RETRY_DENIED");
    }
    const started = Date.now();
    activityLog.info("activity started");
    const timer = setInterval(() => context.heartbeat(), HEARTBEAT_MS);
    try {
      context.heartbeat();
      const result = await handler(raw, context.cancellationSignal);
      activityLog.info({ durationMs: Date.now() - started }, "activity finished");
      return result;
    } catch (error) {
      const durationMs = Date.now() - started;
      if (context.cancellationSignal.aborted) {
        activityLog.warn({ durationMs, err: error }, "activity cancelled");
      }
      context.cancellationSignal.throwIfAborted();
      const code = errorCodeOf(error) ?? "PIPELINE.ACTIVITY_UNRESOLVED";
      activityLog.error({ code, durationMs, err: error }, "activity failed");
      throw ApplicationFailure.nonRetryable(`${name} failed`, code);
    } finally {
      clearInterval(timer);
    }
  };
}
