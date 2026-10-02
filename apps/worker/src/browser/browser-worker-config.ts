import { browserResources, browserTaskQueue } from "@crawl-automation/platform/browser-routing";
import type { z } from "zod";
import type { WorkerProcesses } from "../processes/process-config.js";
import type { BrowserSettingsSchema } from "./browser-settings.js";

interface BrowserWorkerConfig {
  browser?: z.output<typeof BrowserSettingsSchema> | undefined;
  resourceKinds: Record<string, string>;
  processes?: WorkerProcesses | undefined;
  resourceHealth?: { resources: Record<string, { taskQueues: string[] }> } | undefined;
}

/** A browser role cannot silently keep polling a shared queue after a configuration upgrade. */
export function validateBrowserWorker(config: BrowserWorkerConfig, context: z.RefinementCtx): void {
  const browser = config.browser;
  if (!browser) {
    return;
  }
  if (config.resourceKinds[browser.resourceId] !== "browser") {
    context.addIssue({
      code: "custom",
      path: ["resourceKinds", browser.resourceId],
      message: "Declare the local browser resource kind as browser",
    });
  }
  for (const [name, process] of Object.entries(config.processes ?? {})) {
    process.roles.forEach((role, index) => {
      if (role.role === "browser" && role.taskQueue !== browserTaskQueue(browser.resourceId)) {
        context.addIssue({
          code: "custom",
          path: ["processes", name, "roles", index, "taskQueue"],
          message: "Browser role must poll the queue derived from browser.resourceId",
        });
      }
    });
  }
  validateBrowserHealth(config, context);
}

function validateBrowserHealth(config: BrowserWorkerConfig, context: z.RefinementCtx): void {
  for (const resourceId of browserResources(Object.keys(config.resourceHealth?.resources ?? {}))) {
    const target = config.resourceHealth?.resources[resourceId];
    if (
      resourceId !== config.browser?.resourceId ||
      !target?.taskQueues.includes(browserTaskQueue(resourceId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["resourceHealth", "resources", resourceId],
        message: "Monitor only the local browser resource, using its resource-specific queue",
      });
    }
  }
}
