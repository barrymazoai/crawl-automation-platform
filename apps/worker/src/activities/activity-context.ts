import {
  withMeasurementContext,
  type Logger,
  type Measurement,
  type MeasurementIdentity,
} from "@crawl-automation/platform";
import { Context } from "@temporalio/activity";
import { activityIdentity } from "./activity-identity.js";

export interface ActivityMeasurements {
  resolve(identity: MeasurementIdentity): Promise<MeasurementIdentity>;
  record(event: Measurement): Promise<void>;
}

const stores = new WeakMap<Logger, ActivityMeasurements>();

/** Bind the worker's logger to its own repository; no process-global database or cross-worker owner state. */
export function registerActivityMeasurements(log: Logger, store: ActivityMeasurements): void {
  stores.set(log, store);
}

export async function inActivityContext<Result>(
  input: { raw: unknown; log: Logger },
  work: () => Promise<Result>,
): Promise<Result> {
  const { workflowExecution } = Context.current().info;
  let identity = {
    ...activityIdentity(input.raw),
    workflowId: workflowExecution?.workflowId ?? null,
    temporalRunId: workflowExecution?.runId ?? null,
  };
  const store = stores.get(input.log);
  if (store) {
    try {
      identity = await store.resolve(identity);
    } catch (error) {
      input.log.error(
        {
          ...identity,
          err: error,
          outcomeCode: "attribution-unavailable",
          cacheHit: null,
          providerCall: false,
          durationMs: 0,
        },
        "activity attribution lookup failed",
      );
    }
  }
  const record = store ? (event: Measurement) => store.record(event) : async () => undefined;
  const log = input.log.child(identity);
  return withMeasurementContext({ identity, log, record, events: [] }, work);
}
