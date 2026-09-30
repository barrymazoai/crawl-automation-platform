import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { JobDefinition, JobRunner, JobStart } from "@crawl-automation/app";
import type { ProcessDescription } from "pm2";
import { ecosystemApp } from "./ecosystem.js";
import { jobHealth, readHealthFile } from "./job-health.js";
import { loadPm2, pm2Call, type Pm2Api } from "./pm2-client.js";
import { pm2Errors } from "./pm2-errors.js";

interface RunnerOptions {
  client?: () => Promise<Pm2Api>;
  now?: () => number;
  readHealth?: (path: string) => Promise<string | null>;
  prepare?: (job: JobDefinition) => Promise<void>;
}

export class Pm2JobRunner implements JobRunner {
  private client: Pm2Api | undefined;

  constructor(private readonly options: RunnerOptions = {}) {}

  async connect(): Promise<void> {
    this.client = await (this.options.client ?? loadPm2)();
    await pm2Call("connect", (callback) => this.api().connect(callback));
  }

  async disconnect(): Promise<void> {
    this.client?.disconnect();
    this.client = undefined;
  }

  async list(): Promise<string[]> {
    const processes = await pm2Call<ProcessDescription[]>("list", (callback) =>
      this.api().list(callback),
    );
    if (!processes) {
      throw pm2Errors.create("PM2.PROCESS_CONFLICT");
    }
    return processes.flatMap((entry) => (entry.name ? [entry.name] : []));
  }

  async stop(name: string): Promise<void> {
    const process = await this.describe(name);
    if (!process) {
      return;
    }
    const id = processId(process);
    await pm2Call(`stop ${name}`, (callback) => this.api().stop(id, callback));
    await this.requireStopped(name);
  }

  async remove(name: string): Promise<void> {
    const process = await this.requireStopped(name);
    if (!process) {
      return;
    }
    await pm2Call(`delete ${name}`, (callback) => this.api().delete(processId(process), callback));
    if (await this.describe(name)) {
      throw pm2Errors.create("PM2.PROCESS_CONFLICT", { details: { name } });
    }
  }

  async start(job: JobDefinition): Promise<JobStart> {
    if (await this.describe(job.name)) {
      throw pm2Errors.create("PM2.PROCESS_CONFLICT", { details: { name: job.name } });
    }
    await (this.options.prepare ?? prepareDirectories)(job);
    const startedAt = (this.options.now ?? Date.now)();
    await pm2Call(`start ${job.name}`, (callback) => this.api().start(ecosystemApp(job), callback));
    return startReceipt(await this.describe(job.name), startedAt);
  }

  async health(job: JobDefinition, start?: JobStart) {
    const process = await this.describe(job.name);
    const path = job.env.V3_WORKER_HEALTH_FILE;
    const bytes = path ? await (this.options.readHealth ?? readHealthFile)(path) : null;
    return jobHealth({
      job,
      process,
      bytes,
      now: (this.options.now ?? Date.now)(),
      ...(start ? { start } : {}),
    });
  }

  private api(): Pm2Api {
    if (!this.client) {
      throw pm2Errors.create("PM2.DAEMON_REQUIRED");
    }
    return this.client;
  }

  private async describe(name: string): Promise<ProcessDescription | undefined> {
    const result = await pm2Call<ProcessDescription[]>(`describe ${name}`, (callback) =>
      this.api().describe(name, callback),
    );
    if (!result || result.length > 1 || result.some((entry) => entry.name !== name)) {
      throw pm2Errors.create("PM2.PROCESS_CONFLICT", { details: { name } });
    }
    return result[0];
  }

  private async requireStopped(name: string): Promise<ProcessDescription | undefined> {
    const process = await this.describe(name);
    if (
      process &&
      (process.pid || !["stopped", "errored"].includes(process.pm2_env?.status ?? ""))
    ) {
      throw pm2Errors.create("PM2.PROCESS_CONFLICT", { details: { name } });
    }
    return process;
  }
}

function startReceipt(process: ProcessDescription | undefined, requestedAt: number): JobStart {
  const uptime = process?.pm2_env?.pm_uptime;
  if (!process?.pid || process.pm2_env?.status !== "online" || !uptime || uptime < requestedAt) {
    throw pm2Errors.create("PM2.PROCESS_CONFLICT", { details: { name: process?.name } });
  }
  return { pid: process.pid, startedAt: uptime };
}

function processId(process: ProcessDescription): number {
  if (process.pm_id === undefined) {
    throw pm2Errors.create("PM2.PROCESS_CONFLICT", { details: { name: process.name } });
  }
  return process.pm_id;
}

async function prepareDirectories(job: JobDefinition): Promise<void> {
  const paths = [job.outFile, job.errorFile, job.env.V3_WORKER_HEALTH_FILE].filter(
    (path): path is string => typeof path === "string",
  );
  await Promise.all(paths.map((path) => mkdir(dirname(path), { recursive: true, mode: 0o700 })));
}
