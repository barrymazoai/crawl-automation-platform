import {
  brandEnrichmentActivities,
  brandEnrichmentModelActivities,
  brandEnrichmentBrowserActivities,
} from "../activities/brand-enrichment-activities.js";
import type { WorkerSpec } from "@crawl-automation/platform/temporal-worker";
import { browserTaskQueue, LEGACY_BROWSER_QUEUE } from "@crawl-automation/platform/browser-routing";
import { browserActivities } from "../activities/browser-activities.js";
import { collectionActivities } from "../activities/collection-activities.js";
import { brandListingActivities } from "../activities/brand-listing-activities.js";
import { labelActivities, modelActivities, ocrActivities } from "../activities/label-activities.js";
import { resourceActivities } from "../activities/resource-activities.js";
import { pipelineActivities } from "../activities/pipeline-activities.js";
import {
  enrichmentModelActivities,
  enrichmentPipelineActivities,
} from "../activities/enrichment-activities.js";
import type { WorkerParts } from "../container.js";
import type { ProcessRole, WorkerRole } from "./process-config.js";
import {
  dtcGalleryPipelineActivities,
  dtcGalleryModelActivities,
} from "../activities/dtc-gallery-activities.js";

type RoleWork = Pick<WorkerSpec, "activities" | "workflowBundlePath">;

/** What each role runs: its activities and, for a role that hosts workflows, the workflow bundle. */
const workflowBundlePath = new URL("./workflows.cjs", import.meta.url).pathname;

const roleWork: Record<WorkerRole, (parts: WorkerParts) => RoleWork> = {
  // Product runs, and brand runs (CollectionWorkflow) waiting for their brand scan.
  "brand-enrichment": (parts) => ({
    activities: { ...brandEnrichmentActivities(parts), ...brandEnrichmentModelActivities(parts) },
    workflowBundlePath,
  }),
  pipeline: (parts) => ({
    activities: {
      ...pipelineActivities(parts),
      ...enrichmentPipelineActivities(parts),
      ...dtcGalleryPipelineActivities(parts),
      ...collectionActivities(parts),
      ...brandListingActivities(parts),
    },
    workflowBundlePath,
  }),
  // The Label workflow and its steps that need neither a model nor the OCR API.
  label: (parts) => ({ activities: labelActivities(parts), workflowBundlePath }),
  "label-ocr": (parts) => ({ activities: ocrActivities(parts) }),
  "label-model": (parts) => ({
    activities: {
      ...modelActivities(parts),
      ...brandEnrichmentModelActivities(parts),
      ...enrichmentModelActivities(parts),
      ...dtcGalleryModelActivities(parts),
    },
  }),
  resources: (parts) => ({ activities: resourceActivities(parts) }),
  // Browser workers run on each Mac mini with Ego for DTC and Amazon Store-page brands.
  // Whole Foods waits on its fetch test. The role also hosts the API's browser brand-scan workflow.
  browser: (parts) => ({
    activities: {
      ...browserActivities(parts),
      ...brandListingActivities(parts),
      ...brandEnrichmentBrowserActivities(parts),
    },
    workflowBundlePath,
  }),
};

/** One Temporal worker per role of the process, each on its own task queue with its own limits. */
export function roleWorkers(roles: readonly ProcessRole[], parts: WorkerParts): WorkerSpec[] {
  return roles.flatMap((entry) =>
    roleQueues(entry, parts).map((taskQueue) => ({
      ...roleWork[entry.role](parts),
      taskQueue,
      maxConcurrentActivities: entry.maxConcurrentActivities,
      ...(entry.maxConcurrentWorkflowTasks
        ? { maxConcurrentWorkflowTasks: entry.maxConcurrentWorkflowTasks }
        : {}),
      log: parts.log,
    })),
  );
}

function roleQueues(entry: ProcessRole, parts: WorkerParts): string[] {
  if (entry.role === "brand-enrichment" && parts.config.brandEnrichment) {
    return [...new Set([entry.taskQueue, parts.config.brandEnrichment.queues.activities])];
  }
  if (entry.role !== "browser") {
    return [entry.taskQueue];
  }
  const browser = parts.config.browser;
  if (!browser) {
    return [entry.taskQueue];
  }
  return [
    browserTaskQueue(browser.resourceId),
    ...(browser.pollLegacyQueue ? [LEGACY_BROWSER_QUEUE] : []),
  ];
}
