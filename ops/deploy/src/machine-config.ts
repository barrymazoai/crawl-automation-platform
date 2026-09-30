import { isAbsolute } from "node:path";
import { z } from "zod";

const absolutePath = z.string().refine(isAbsolute, "an absolute path");
const jobId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/)
  .refine((name) => name !== "all");

/** The apps a machine can run, the workspace package each is built from, and the file the job starts. */
export const APPS = {
  api: { filter: "@crawl-automation/api", entry: "apps/api/dist/main.js" },
  worker: { filter: "@crawl-automation/worker", entry: "apps/worker/dist/main.js" },
} as const;
export type AppName = keyof typeof APPS;

/** One long-running job on this machine: which app, which worker process, and its private settings files. */
export const MachineJobSchema = z
  .strictObject({
    id: jobId,
    app: z.enum(["api", "worker"]),
    /** For a worker: the process of the worker config it runs (`V3_WORKER_PROCESS`). */
    process: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,62}$/)
      .optional(),
    args: z.array(z.string()).default([]),
    healthFile: absolutePath,
    logs: z.strictObject({ out: absolutePath, error: absolutePath }),
    /** The job's environment, e.g. `V3_API_CONFIG` or `V3_PIPELINE_CONFIG` naming a private settings file. */
    env: z.record(z.string().regex(/^V3_[A-Z_]+$/), z.string().min(1)),
  })
  .refine((job) => (job.app === "worker") === (job.process !== undefined), {
    message: "a worker job names its process; an API job names none",
  })
  .refine((job) => !("V3_WORKER_PROCESS" in job.env), {
    message: "V3_WORKER_PROCESS comes from `process`",
  })
  .refine((job) => !("V3_WORKER_HEALTH_FILE" in job.env), {
    message: "V3_WORKER_HEALTH_FILE comes from `healthFile`",
  })
  .refine(
    (job) =>
      absolutePath.safeParse(job.env[job.app === "api" ? "V3_API_CONFIG" : "V3_PIPELINE_CONFIG"])
        .success,
    { message: "each job needs its absolute API or pipeline config path" },
  );
export type MachineJob = z.output<typeof MachineJobSchema>;

/**
 * One machine's deployment (a private file on that machine, copied there by SCP; never in git). Code itself only
 * arrives by `git clone` of origin `main`.
 */
export const MachineConfigSchema = z
  .strictObject({
    machine: jobId,
    /** The origin repository the release is cloned from. */
    repository: z.string().min(1),
    /** Releases go to `<root>/releases/<commit>/source`. */
    root: absolutePath,
    tools: z.strictObject({ node: absolutePath, pnpm: absolutePath, git: absolutePath }),
    /** One PM2 ecosystem JSON file, with byte-exact backups before replacement. */
    pm2: z.strictObject({ file: absolutePath, backups: absolutePath }),
    jobs: z.array(MachineJobSchema).min(1).max(32),
    /** Database upgrades (only with `--migrate`); the connection string comes from the operator's V3_DATABASE_URL. */
    migrations: z
      .strictObject({
        backups: absolutePath,
        /** The exact host:port/database that the migration service must confirm. */
        confirm: z.string().min(3),
        /** Optional absolute path to the PostgreSQL dump executable; otherwise pg_dump on PATH. */
        pgDump: absolutePath.optional(),
      })
      .optional(),
    health: z
      .strictObject({
        attempts: z.number().int().min(1).max(60),
        intervalMs: z.number().int().min(500).max(60_000),
      })
      .default({ attempts: 12, intervalMs: 5_000 }),
  })
  .refine((config) => new Set(config.jobs.map((job) => job.id)).size === config.jobs.length, {
    message: "job ids are unique",
  })
  .refine(
    (config) => new Set(config.jobs.map((job) => job.healthFile)).size === config.jobs.length,
    {
      message: "each job needs a separate health file",
    },
  );
export type MachineConfig = z.output<typeof MachineConfigSchema>;
