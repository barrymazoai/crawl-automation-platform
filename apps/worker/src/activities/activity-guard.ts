import { refreshActivityPolicies } from "./activity-policies.js";
import { withCause, isAppError } from "@crawl-automation/platform";
import { pipelineErrors } from "@crawl-automation/platform";
import { resourceGateErrors } from "@crawl-automation/platform/errors/resource-gate";
import { errorCodeOf, type Logger } from "@crawl-automation/platform";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { activityLogger } from "./activity-log.js";
import { runWithPermitActivity } from "@crawl-automation/app";
import { inActivityContext } from "./activity-context.js";
import { activityOutcome, measureActivity } from "./activity-outcome.js";

type ActivityHandler = (raw: unknown, signal: AbortSignal) => Promise<unknown>;
type Handler =
  | ActivityHandler
  | {
      run: ActivityHandler;
      beforePermit(raw: unknown): Promise<void>;
    };

const HEARTBEAT_MS = 2_000;

/**
 * Runs one activity the pipeline's way: only the first attempt may run (paid and model work is never retried),
 * it heartbeats while it works, it logs its start, end and failure with the run's IDs, and any failure leaves as a
 * non-retryable failure carrying the error's code.
 */
export function guarded(name: string, handler: Handler, log: Logger) {
  return (raw: unknown): Promise<unknown> =>
    inActivityContext({ raw, log }, () => executeActivity({ name, handler, log }, raw));
}

async function executeActivity(
  work: { name: string; handler: Handler; log: Logger },
  raw: unknown,
): Promise<unknown> {
  const { name, handler, log } = work;
  const context = Context.current();
  const activityLog = activityLogger(log, name, raw);
  if (context.info.attempt !== 1) {
    activityLog.warn(
      { attempt: context.info.attempt, outcomeCode: pipelineErrors.code("PIPELINE.RETRY_DENIED") },
      "activity retry denied",
    );
    throw ApplicationFailure.nonRetryable(
      "Automatic retry denied",
      pipelineErrors.code("PIPELINE.RETRY_DENIED"),
    );
  }
  const started = Date.now();
  activityLog.info("activity started");
  const timer = setInterval(() => context.heartbeat(), HEARTBEAT_MS);
  try {
    context.heartbeat();
    const preparing = refreshActivityPolicies(log, raw);
    if (preparing) {
      await preparing;
    }
    const result = await executeHandler(handler, raw);
    const facts = activityOutcome(name, result);
    activityLog.info({ ...facts, durationMs: Date.now() - started }, "activity finished");
    await measureActivity(name, started, facts);
    return result;
  } catch (error) {
    return failActivity({ name, started, log: activityLog }, error);
  } finally {
    clearInterval(timer);
  }
}

/** Pipeline work must have an exact workflow owner before it can use provider capacity. */
async function executeHandler(handler: Handler, raw: unknown): Promise<unknown> {
  const context = Context.current();
  const { activityId, workflowExecution } = context.info;
  if (!workflowExecution) {
    throw resourceGateErrors.create("RESOURCE.IDENTITY_CONFLICT");
  }
  if (typeof handler !== "function") {
    await handler.beforePermit(raw);
  }
  const run = typeof handler === "function" ? handler : handler.run;
  return runWithPermitActivity({ activityId, workflowExecution }, () =>
    run(raw, context.cancellationSignal),
  );
}

async function failActivity(
  work: { name: string; started: number; log: Logger },
  error: unknown,
): Promise<never> {
  const signal = Context.current().cancellationSignal;
  const code = errorCodeOf(error) ?? pipelineErrors.code("PIPELINE.ACTIVITY_UNRESOLVED");
  const facts = {
    ...activityOutcome(work.name, null),
    outcomeCode: signal.aborted ? "cancelled" : code,
  };
  await measureActivity(work.name, work.started, facts);
  work.log.error(
    { ...facts, code, durationMs: Date.now() - work.started, err: error },
    "activity failed",
  );
  signal.throwIfAborted();
  const details = isAppError(error) ? [error.details] : [];
  throw withCause(ApplicationFailure.nonRetryable(`${work.name} failed`, code, ...details), error);
}
