import { imageActivityOptions } from "@crawl-automation/v3-contracts";
import { heartbeatTimeout } from "../activity-options.js";

/** Keep the legacy shared contract unchanged for workflows that have not adopted the patch. */
export function labelActivityOptions(taskQueue: string, heartbeats: boolean) {
  const options = imageActivityOptions(taskQueue);
  return heartbeats ? { ...options, heartbeatTimeout } : options;
}
