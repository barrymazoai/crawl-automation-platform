import { patched, proxyActivities } from "@temporalio/workflow";
import type { PipelineActivities } from "./pipeline-model.js";
import { withHeartbeatFailure } from "./label/activity-heartbeat.js";

/** One attempt per Activity: a failure becomes a Review, never an automatic retry of paid or model work. */
export const once = {
  startToCloseTimeout: "10 minutes",
  scheduleToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 1 },
} as const;

export const heartbeatTimeout = "30 seconds";

/** Only downloads change: old histories keep their original options and failure handling. */
export function withDownloadHeartbeat(pipeline: PipelineActivities, taskQueue: string) {
  const acquireProductFile: PipelineActivities["acquireProductFile"] = (request) => {
    // Evaluate at the download, after capture/reuse markers, never during pipeline construction.
    if (!patched("download-heartbeat-v1")) {
      return pipeline.acquireProductFile(request);
    }
    const download = proxyActivities<Pick<PipelineActivities, "acquireProductFile">>({
      taskQueue,
      ...once,
      heartbeatTimeout,
    });
    return withHeartbeatFailure(() => download.acquireProductFile(request));
  };
  return new Proxy(pipeline, {
    get(target, property, receiver) {
      return property === "acquireProductFile"
        ? acquireProductFile
        : Reflect.get(target, property, receiver);
    },
  });
}
