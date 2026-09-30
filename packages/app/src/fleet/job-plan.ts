import { isDeepStrictEqual } from "node:util";
import { jobErrors } from "./job-errors.js";
import type { JobChange, JobDefinition, JobDeployment } from "./job-ports.js";

export function compareJobs(
  previous: readonly JobDefinition[],
  next: readonly JobDefinition[],
): JobChange {
  const unchanged = next
    .filter((job) =>
      isDeepStrictEqual(
        previous.find((entry) => entry.name === job.name),
        job,
      ),
    )
    .map((job) => job.name);
  return {
    changed: next.filter((job) => !unchanged.includes(job.name)).map((job) => job.name),
    removed: previous
      .filter((job) => !next.some((entry) => entry.name === job.name))
      .map((job) => job.name),
    unchanged,
  };
}

export function validateJobDeployment(request: JobDeployment): void {
  const { attempts, intervalMs } = request.health;
  const unique = new Set(request.jobs.map((job) => job.name));
  if (
    unique.size !== request.jobs.length ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 60 ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > 60_000
  ) {
    throw jobErrors.create("JOBS.INVALID_PLAN");
  }
}
