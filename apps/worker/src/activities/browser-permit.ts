import { PostgresResourceStore } from "@crawl-automation/adapters";
import { assertBrowserPermit } from "@crawl-automation/app";
import { browserTaskQueue, LEGACY_BROWSER_QUEUE } from "@crawl-automation/platform/browser-routing";
import { resourceGateErrors } from "@crawl-automation/platform/errors/resource-gate";
import { Context } from "@temporalio/activity";
import type { WorkerParts } from "../container.js";

/** Called before runWithPermitActivity begins, including for shared-queue legacy dispatch. */
export async function checkBrowserPermit(parts: WorkerParts): Promise<void> {
  const { activityId, workflowExecution, taskQueue } = Context.current().info;
  const browser = parts.config.browser;
  const legacy =
    browser?.resourceId === "mini-ego-space-1" &&
    browser.pollLegacyQueue &&
    taskQueue === LEGACY_BROWSER_QUEUE;
  if (
    !browser ||
    !workflowExecution ||
    (taskQueue !== browserTaskQueue(browser.resourceId) && !legacy)
  ) {
    throw resourceGateErrors.create("RESOURCE.BROWSER_PERMIT_MISMATCH");
  }
  await assertBrowserPermit({
    resources: new PostgresResourceStore(parts.database),
    owner: { permitId: activityId, ...workflowExecution },
    resourceId: browser.resourceId,
  });
}
