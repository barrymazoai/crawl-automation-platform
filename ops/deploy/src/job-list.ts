import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { APPS, type MachineConfig, type MachineJob } from "./machine-config.js";

/** The fields of the job list this command rewrites; everything else in the file is kept as it is. */
const JobListSchema = z
  .object({
    jobs: z.array(
      z.object({ id: z.string(), entry: z.string(), env: z.record(z.string(), z.string()) }),
    ),
    resources: z.array(z.object({ jobs: z.array(z.string()) }).passthrough()).default([]),
  })
  .passthrough();
type JobList = z.output<typeof JobListSchema>;

export interface JobListChange {
  next: JobList;
  /** Jobs that are new or start differently: only these are restarted. */
  changed: string[];
  /** Jobs the machine no longer runs (old code): stopped and taken off the list. */
  removed: string[];
  /** Resources that named only removed jobs, dropped with them. */
  droppedResources: number;
}

/** A job of the new release, as the control script starts it. */
export function releaseJob(job: MachineJob, source: string) {
  const env = job.process ? { ...job.env, V3_WORKER_PROCESS: job.process } : job.env;
  return { id: job.id, entry: `${source}/${APPS[job.app].entry}`, env };
}

/**
 * The machine's next job list: exactly the machine config's jobs, started from the new release. Only the new
 * version runs, so jobs not in the machine config are removed, and every resource stops naming them (the control
 * script refuses a resource that names a missing job).
 */
export function nextJobList(
  currentRaw: unknown,
  machine: Pick<MachineConfig, "jobs">,
  source: string,
): JobListChange {
  const current = JobListSchema.parse(currentRaw);
  const jobs = machine.jobs.map((job) => releaseJob(job, source));
  const ids = new Set(jobs.map((job) => job.id));
  const changed = jobs
    .filter(
      (job) =>
        !isDeepStrictEqual(
          current.jobs.find((old) => old.id === job.id),
          job,
        ),
    )
    .map((job) => job.id);
  const removed = current.jobs.filter((job) => !ids.has(job.id)).map((job) => job.id);
  const resources = current.resources
    .map((resource) => ({ ...resource, jobs: resource.jobs.filter((id) => ids.has(id)) }))
    .filter((resource) => resource.jobs.length > 0);
  return {
    next: { ...current, jobs, resources },
    changed,
    removed,
    droppedResources: current.resources.length - resources.length,
  };
}
