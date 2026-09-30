import type { WorkerConfig } from "../config.js";
import { resourceErrors } from "../resources/resource-errors.js";
import type { WorkerRole } from "./process-config.js";

type RoleSection = "capture" | "plan" | "label" | "processing";

/** Required sections follow the activities a role exposes, regardless of its process name. */
const REQUIRED: Record<WorkerRole, readonly RoleSection[]> = {
  pipeline: ["capture", "plan", "label"],
  browser: ["plan"],
  label: ["processing"],
  "label-ocr": ["processing"],
  "label-model": ["processing"],
  resources: [],
};

/** All declared processes must be runnable; old taskQueue-only configs still run pipeline. */
export function checkWorkerRoleSettings(config: WorkerConfig): void {
  const roles = config.processes
    ? Object.values(config.processes).flatMap((process) => process.roles.map((entry) => entry.role))
    : ["pipeline" as const];
  for (const role of new Set(roles)) {
    for (const section of REQUIRED[role]) {
      requireRoleSection(config, section, role);
    }
  }
}

/** Composition uses the same guard as startup, without inventing settings for an absent role. */
export function requireRoleSection<Section extends RoleSection>(
  config: Pick<WorkerConfig, Section>,
  section: Section,
  role: WorkerRole,
): NonNullable<WorkerConfig[Section]> {
  const settings = config[section];
  if (settings === undefined) {
    throw resourceErrors.create("WORKER.ROLE_SETTINGS_MISSING", { details: { role, section } });
  }
  return settings;
}
