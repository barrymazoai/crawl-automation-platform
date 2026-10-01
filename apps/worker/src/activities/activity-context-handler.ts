import { measuredCall, type Logger } from "@crawl-automation/platform";
import { inActivityContext } from "./activity-context.js";
import { activityOutcome } from "./activity-outcome.js";

/** Measurement for idempotent control activities; preserves their existing retry/failure policy. */
export function contextualActivity(
  name: string,
  handler: (raw: unknown) => Promise<unknown>,
  log: Logger,
) {
  return (raw: unknown) =>
    inActivityContext({ raw, log }, () =>
      measuredCall(
        { kind: "activity", step: name },
        () => handler(raw),
        (result) => activityOutcome(name, result),
      ),
    );
}
