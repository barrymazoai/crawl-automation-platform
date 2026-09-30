import { setTimeout as sleep } from "node:timers/promises";
import { JobService } from "@crawl-automation/app";
import { Pm2JobRunner, Pm2ProcessFile } from "@crawl-automation/adapters";
import { releaseJobs } from "./job-list.js";
import type { MachineConfig } from "./machine-config.js";

/** Deployment composition: the application service owns switching, stopping, starting and readiness. */
export async function runMachineJobs(
  machine: MachineConfig,
  source: string,
  options: { dryRun: boolean; print(line: string): void },
): Promise<void> {
  const service = new JobService({
    file: new Pm2ProcessFile(machine.pm2),
    runner: new Pm2JobRunner(),
    sleep: (milliseconds) => sleep(milliseconds),
  });
  const request = { jobs: releaseJobs(machine, source), health: machine.health };
  if (options.dryRun) {
    const change = await service.preview(request);
    options.print(`  PM2 file: ${machine.pm2.file}; backups: ${machine.pm2.backups}`);
    options.print(`  changed: ${change.changed.join(", ") || "none"}`);
    options.print(`  removed: ${change.removed.join(", ") || "none"}`);
    return;
  }
  const progress = await service.deploy(request);
  options.print(`  jobs verified: ${JSON.stringify(progress)}`);
}
