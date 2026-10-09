import { z } from "zod";

/**
 * The roles this worker can run. A role is one kind of work on its own task queue; a machine's config groups roles
 * into a few processes. New roles (the label steps) are added here together with their workers in `role-workers.ts`.
 */
export const WORKER_ROLES = [
  "pipeline",
  "brand-enrichment",
  "label",
  "label-ocr",
  "label-model",
  "resources",
  "browser",
] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

const processName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, "lower-case words joined by -");

/** One role inside a process: which task queue it polls and how much work it takes at once. */
export const ProcessRoleSchema = z.strictObject({
  role: z.enum(WORKER_ROLES),
  taskQueue: z.string().min(1).max(200),
  maxConcurrentActivities: z.number().int().min(1).max(64).default(4),
  maxConcurrentWorkflowTasks: z.number().int().min(1).max(64).optional(),
});
export type ProcessRole = z.output<typeof ProcessRoleSchema>;

/** One operating-system process: the roles it runs together. A role and a task queue appear once per process. */
export const WorkerProcessSchema = z
  .strictObject({ roles: z.array(ProcessRoleSchema).min(1).max(16) })
  .refine((process) => unique(process.roles.map((entry) => entry.role)), "a role appears twice")
  .refine(
    (process) => unique(process.roles.map((entry) => entry.taskQueue)),
    "a task queue appears twice",
  );

/** The processes this machine runs, by name (e.g. `pipeline`, `label-text`, `label-vision`, `browser`). */
export const WorkerProcessesSchema = z
  .record(processName, WorkerProcessSchema)
  .refine((processes) => Object.keys(processes).length > 0, "at least one process");
export type WorkerProcesses = z.output<typeof WorkerProcessesSchema>;

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** The single process of a config written before processes existed: the pipeline on its one task queue. */
export const DEFAULT_PROCESS = "pipeline";
