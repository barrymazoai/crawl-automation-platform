import { AppError } from "@crawl-automation/platform";
import { jobErrors } from "./job-errors.js";
import { compareJobs, validateJobDeployment } from "./job-plan.js";
import type {
  JobChange,
  JobDefinition,
  JobDeployment,
  JobHealth,
  JobProgress,
  JobServicePorts,
  JobStart,
} from "./job-ports.js";

/** Owns deployment order. Process manager calls and filesystem operations belong to adapters. */
export class JobService {
  constructor(private readonly ports: JobServicePorts) {}

  async preview(request: JobDeployment): Promise<JobChange> {
    validateJobDeployment(request);
    return compareJobs(await this.ports.file.read(), request.jobs);
  }

  async deploy(request: JobDeployment): Promise<JobProgress> {
    validateJobDeployment(request);
    const progress: JobProgress = {
      changed: [],
      removed: [],
      unchanged: [],
      backup: null,
      written: false,
      stopped: [],
      removedFromRunner: [],
      started: [],
      phase: "read",
      job: null,
    };
    let failure: { error: unknown } | undefined;
    try {
      await this.apply(request, progress);
    } catch (error) {
      failure = { error };
    }
    if (!failure) {
      progress.phase = "disconnect";
    }
    try {
      await this.ports.runner.disconnect();
    } catch (error) {
      failure = {
        error: failure
          ? new AggregateError([failure.error, error], "Job deployment and disconnect failed")
          : error,
      };
    }
    if (failure) {
      throw jobErrors.create("JOBS.APPLY_FAILED", {
        cause: failure.error,
        details: { ...progress, failure: failureDetails(failure.error) },
      });
    }
    return { ...progress, phase: "complete" };
  }

  private async apply(request: JobDeployment, progress: JobProgress): Promise<void> {
    const previous = await this.ports.file.read();
    Object.assign(progress, compareJobs(previous, request.jobs));
    progress.phase = "connect";
    await this.ports.runner.connect();
    progress.phase = "inventory";
    const names = await this.ports.runner.list();
    this.checkOwnership(previous, request.jobs, names);
    progress.phase = "write";
    const receipt = await this.ports.file.replace(request.jobs);
    progress.backup = receipt.backup;
    progress.written = true;
    await this.stopChanged(previous, progress);
    const starts = await this.startChanged(request.jobs, progress);
    progress.phase = "health";
    progress.job = null;
    await this.waitForReady(request, starts);
    progress.phase = "complete";
  }

  private checkOwnership(previous: JobDefinition[], next: JobDefinition[], names: string[]): void {
    const conflicts = next
      .filter(
        (job) => names.includes(job.name) && !previous.some((entry) => entry.name === job.name),
      )
      .map((job) => job.name);
    if (conflicts.length) {
      throw jobErrors.create("JOBS.NAME_CONFLICT", { details: { jobs: conflicts } });
    }
  }

  private async stopChanged(previous: JobDefinition[], progress: JobProgress): Promise<void> {
    const changed = progress.changed.filter((name) => previous.some((job) => job.name === name));
    const retired = [...progress.removed, ...changed];
    for (const name of retired) {
      progress.phase = "stop";
      progress.job = name;
      await this.ports.runner.stop(name);
      progress.stopped.push(name);
      progress.phase = "remove";
      await this.ports.runner.remove(name);
      progress.removedFromRunner.push(name);
    }
  }

  private async startChanged(jobs: JobDefinition[], progress: JobProgress) {
    const starts = new Map<string, JobStart>();
    for (const job of jobs.filter((entry) => progress.changed.includes(entry.name))) {
      progress.phase = "start";
      progress.job = job.name;
      starts.set(job.name, await this.ports.runner.start(job));
      progress.started.push(job.name);
    }
    return starts;
  }

  private async waitForReady(request: JobDeployment, starts: Map<string, JobStart>): Promise<void> {
    let health: JobHealth[] = [];
    for (let attempt = 1; attempt <= request.health.attempts; attempt += 1) {
      health = await Promise.all(
        request.jobs.map((job) => this.ports.runner.health(job, starts.get(job.name))),
      );
      if (health.every((job) => job.ready)) {
        return;
      }
      if (attempt < request.health.attempts) {
        await this.ports.sleep(request.health.intervalMs);
      }
    }
    throw jobErrors.create("JOBS.UNHEALTHY", { details: { health } });
  }
}

function failureDetails(error: unknown): Record<string, unknown> {
  if (error instanceof AggregateError) {
    return { errors: error.errors.map(failureDetails) };
  }
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { message: String(error) };
}
