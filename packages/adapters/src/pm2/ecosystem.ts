import { isAbsolute } from "node:path";
import type { JobDefinition } from "@crawl-automation/app";
import { z } from "zod";
import { pm2Errors } from "./pm2-errors.js";

const path = z.string().refine(isAbsolute);
const appSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/)
    .refine((name) => name !== "all"),
  script: path,
  args: z.array(z.string()),
  cwd: path,
  interpreter: path,
  env: z
    .record(z.string(), z.string())
    .refine(
      (env) =>
        typeof env.V3_WORKER_HEALTH_FILE === "string" && isAbsolute(env.V3_WORKER_HEALTH_FILE),
    ),
  out_file: path,
  error_file: path,
  autorestart: z.literal(false),
  watch: z.literal(false),
  exec_mode: z.literal("fork"),
  instances: z.literal(1),
});
const ecosystemSchema = z
  .strictObject({ apps: z.array(appSchema) })
  .refine((file) => new Set(file.apps.map((app) => app.name)).size === file.apps.length);

/** The file and programmatic starts use exactly the same options. No persistence or restart policy. */
export function ecosystemApp(job: JobDefinition): z.output<typeof appSchema> {
  return appSchema.parse({
    name: job.name,
    script: job.script,
    args: job.args,
    cwd: job.cwd,
    interpreter: job.interpreter,
    env: job.env,
    out_file: job.outFile,
    error_file: job.errorFile,
    autorestart: false,
    watch: false,
    exec_mode: "fork",
    instances: 1,
  });
}

export function ecosystem(jobs: readonly JobDefinition[]) {
  return ecosystemSchema.parse({ apps: jobs.map(ecosystemApp) });
}

export function readEcosystem(bytes: string): JobDefinition[] {
  try {
    const file = ecosystemSchema.parse(JSON.parse(bytes));
    return file.apps.map((app) => ({
      name: app.name,
      script: app.script,
      args: app.args,
      cwd: app.cwd,
      interpreter: app.interpreter,
      env: app.env,
      outFile: app.out_file,
      errorFile: app.error_file,
    }));
  } catch (error) {
    throw pm2Errors.create("PM2.FILE_INVALID", { cause: error });
  }
}
