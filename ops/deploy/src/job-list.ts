import type { JobDefinition } from "@crawl-automation/app";
import { APPS, type MachineConfig, type MachineJob } from "./machine-config.js";

/** The machine config supplies paths and names; the release supplies the executable entry. */
export function releaseJob(job: MachineJob, source: string, interpreter: string): JobDefinition {
  return {
    name: job.id,
    script: `${source}/${APPS[job.app].entry}`,
    args: job.args,
    cwd: source,
    interpreter,
    env: {
      ...job.env,
      ...(job.process ? { V3_WORKER_PROCESS: job.process } : {}),
      V3_WORKER_HEALTH_FILE: job.healthFile,
    },
    outFile: job.logs.out,
    errorFile: job.logs.error,
  };
}

export function releaseJobs(machine: MachineConfig, source: string): JobDefinition[] {
  return machine.jobs.map((job) => releaseJob(job, source, machine.tools.node));
}
