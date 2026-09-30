import { defineErrors } from "./define-errors.js";

export const activityCodes = {
  heartbeatTimeout: "ACTIVITY.HEARTBEAT_TIMEOUT",
} as const;

/** Workflow-safe registry: this module and its imports contain no Node dependencies. */
export const activityErrors = defineErrors({
  [activityCodes.heartbeatTimeout]: {
    category: "RUNTIME",
    message: "Activity heartbeats stopped; execution could not be verified.",
  },
});

export { withCause } from "./with-cause.js";

export { pipelineErrors } from "./pipeline-errors.js";

export type ActivityErrorCode = keyof typeof activityErrors.codes;
