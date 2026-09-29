import type { WorkerSpec } from "@crawl-automation/platform/temporal-worker";
import { browserActivities } from "../activities/browser-activities.js";
import {
  labelActivities,
  modelActivities,
  ocrActivities,
  resourceActivities,
} from "../activities/label-activities.js";
import { pipelineActivities } from "../activities/pipeline-activities.js";
import type { WorkerParts } from "../container.js";
import type { ProcessRole, WorkerRole } from "./process-config.js";

type RoleWork = Pick<WorkerSpec, "activities" | "workflowBundlePath">;

/** What each role runs: its activities and, for a role that hosts workflows, the workflow bundle. */
const workflowBundlePath = new URL("./workflows.cjs", import.meta.url).pathname;

const roleWork: Record<WorkerRole, (parts: WorkerParts) => RoleWork> = {
  pipeline: (parts) => ({ activities: pipelineActivities(parts), workflowBundlePath }),
  // The Label workflow and its steps that need neither a model nor the OCR API.
  label: (parts) => ({ activities: labelActivities(parts), workflowBundlePath }),
  "label-ocr": (parts) => ({ activities: ocrActivities(parts) }),
  "label-model": (parts) => ({ activities: modelActivities(parts) }),
  resources: (parts) => ({ activities: resourceActivities(parts) }),
  // Pages only the Ego browser can read (Whole Foods), on the machine that runs Ego (Server 二); it also hosts the
  // API's brand-scan workflow for them, so the API never drives a browser.
  browser: (parts) => ({ activities: browserActivities(parts), workflowBundlePath }),
};

/** One Temporal worker per role of the process, each on its own task queue with its own limits. */
export function roleWorkers(roles: readonly ProcessRole[], parts: WorkerParts): WorkerSpec[] {
  return roles.map((entry) => ({
    ...roleWork[entry.role](parts),
    taskQueue: entry.taskQueue,
    maxConcurrentActivities: entry.maxConcurrentActivities,
    ...(entry.maxConcurrentWorkflowTasks
      ? { maxConcurrentWorkflowTasks: entry.maxConcurrentWorkflowTasks }
      : {}),
    log: parts.log,
  }));
}
