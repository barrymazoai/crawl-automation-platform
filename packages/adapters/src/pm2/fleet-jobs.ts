import { isAbsolute, resolve } from "node:path";
import { fleetIssue, type FleetJobObservation } from "@crawl-automation/app";
import type { ProcessDescription } from "pm2";
import { z } from "zod";
import { Pm2FleetFiles } from "./fleet-health.js";
import { loadPm2, pm2Call, type Pm2Api } from "./pm2-client.js";
import { pm2Errors } from "./pm2-errors.js";

interface FleetJobsOptions {
  client?: () => Promise<Pm2Api>;
  files?: Pm2FleetFiles;
}

const environmentSchema = z.object({
  V3_WORKER_PROCESS: z.string().optional(),
  V3_WORKER_CONFIG: z.string().optional(),
  V3_WORKER_HEALTH_FILE: z.string().optional(),
  V3_API_CONFIG: z.string().optional(),
});

/** Attach to the R09 manual daemon, observe every job, then detach. Never start or change a job. */
export class Pm2FleetJobs {
  private pending: Promise<FleetJobObservation[]> | undefined;

  constructor(private readonly options: FleetJobsOptions = {}) {}

  list(): Promise<FleetJobObservation[]> {
    // PM2's client is shared; overlapping status requests must not disconnect each other.
    this.pending ??= this.snapshot().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async snapshot(): Promise<FleetJobObservation[]> {
    const client = await (this.options.client ?? loadPm2)();
    try {
      await pm2Call("connect", (callback) => client.connect(callback));
      const processes = await pm2Call<ProcessDescription[]>("list", (callback) =>
        client.list(callback),
      );
      if (!processes) {
        throw pm2Errors.create("PM2.PROCESS_CONFLICT");
      }
      return await Promise.all(processes.map((process) => this.observe(process)));
    } finally {
      client.disconnect();
    }
  }

  private async observe(entry: ProcessDescription): Promise<FleetJobObservation> {
    const runtime = entry.pm2_env;
    const parsed = environmentSchema.safeParse(runtime ?? {});
    const env = parsed.success ? parsed.data : {};
    const process = processName(env, entry.name);
    const files = this.options.files ?? new Pm2FleetFiles();
    const [health, worker] = await Promise.all([
      files.heartbeat(filePath(env.V3_WORKER_HEALTH_FILE, runtime?.pm_cwd)),
      files.queues(filePath(env.V3_WORKER_CONFIG, runtime?.pm_cwd), process),
    ]);
    return {
      ...jobRuntime(entry),
      process,
      queues: worker.queues,
      heartbeat: health.heartbeat,
      issues: [
        ...health.issues,
        ...worker.issues,
        ...(parsed.success ? [] : [fleetIssue(parsed.error)]),
      ],
    };
  }
}

function processName(env: z.output<typeof environmentSchema>, name: string | undefined): string {
  return (
    env.V3_WORKER_PROCESS ??
    (env.V3_WORKER_CONFIG ? "pipeline" : env.V3_API_CONFIG ? "api" : (name ?? "unknown"))
  );
}

function jobRuntime(entry: ProcessDescription) {
  return {
    name: entry.name ?? null,
    status: entry.pm2_env?.status ?? "unknown",
    pid: entry.pid ?? 0,
    restarts: entry.pm2_env?.restart_time ?? 0,
    startedAt: entry.pm2_env?.pm_uptime ?? null,
  };
}

function filePath(path: string | undefined, cwd: string | undefined): string | null {
  if (!path) {
    return null;
  }
  if (isAbsolute(path)) {
    return path;
  }
  return cwd ? resolve(cwd, path) : null;
}
