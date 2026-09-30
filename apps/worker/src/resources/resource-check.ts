import {
  resourceKindOf,
  type ResourceKind,
  type ResourceKindOf,
  type ResourceKinds,
} from "@crawl-automation/channels-core";
import type { ResourceGate } from "@crawl-automation/v3-contracts";
import type { WorkerConfig } from "../config.js";
import { KNOWN_RESOURCE_KINDS } from "./known-kinds.js";
import { resourceErrors } from "./resource-errors.js";

/** The parts of the worker's settings the check reads. */
export type CheckedSettings = Pick<
  WorkerConfig,
  "label" | "processes" | "browser" | "resourceKinds"
>;

/** The kind each gated label step must hold: model calls a model permit, OCR calls an OCR permit. */
const REQUIRED_KIND: Readonly<Record<string, ResourceKind>> = {
  interpretText: "model",
  interpretImage: "model",
  ocrFile: "ocr",
};

/** Capture lanes; they guard page capture, never a label step. */
const LANE_KINDS: ReadonlySet<ResourceKind> = new Set(["browser", "http-lane", "file-lane"]);

/** The resource kinds this worker knows: today's resources, overridden by the config's own table. */
export function workerResourceKinds(config: Pick<WorkerConfig, "resourceKinds">): ResourceKindOf {
  const kinds: ResourceKinds = { ...KNOWN_RESOURCE_KINDS, ...config.resourceKinds };
  return resourceKindOf(kinds);
}

/**
 * Checks, once at startup, that every permit this worker's config names fits the work it guards; a mismatch stops
 * the start with its code. Page-capture gates belong to the API's config and are checked there (`assertCaptureGate`).
 */
export function checkWorkerResources(config: CheckedSettings): void {
  const kindOf = workerResourceKinds(config);
  const gates = [config.label?.resources, config.label?.shared?.resources];
  for (const gate of gates.filter((entry) => entry !== undefined)) {
    checkLabelGate(gate, kindOf);
  }
  checkBrowserRole(config);
}

function checkLabelGate(gate: ResourceGate, kindOf: ResourceKindOf): void {
  for (const [activity, needs] of Object.entries(gate.activities)) {
    const kinds = needs.map((need) => kindOf(need.resourceId));
    const required = REQUIRED_KIND[activity];
    const lane = kinds.find((kind) => LANE_KINDS.has(kind));
    if (lane !== undefined || (required !== undefined && !kinds.includes(required))) {
      throw resourceErrors.create("WORKER.RESOURCE_KIND_MISMATCH", {
        details: { activity, needs: needs.map((need) => need.resourceId), kinds, required },
      });
    }
  }
}

/** Browser capture needs a browser space: a process running the browser role needs the Ego settings. */
function checkBrowserRole(config: CheckedSettings): void {
  const processes = Object.values(config.processes ?? {});
  const runsBrowser = processes.some((process) =>
    process.roles.some((entry) => entry.role === "browser"),
  );
  if (runsBrowser && config.browser === undefined) {
    throw resourceErrors.create("WORKER.BROWSER_SETTINGS_MISSING");
  }
}
