import type { CommandStep, Step } from "./deploy-plan.js";
import { deployErrors } from "./deploy-errors.js";
import { nextJobList, type JobListChange } from "./job-list.js";
import { jobsHealthy } from "./job-health.js";
import type { MachineConfig } from "./machine-config.js";

/** Everything the deployment does to the machine, behind one port so a dry run and tests touch nothing. */
export interface DeployPorts {
  /** Runs a command to completion; fails on a non-zero exit. Returns its standard output. */
  run(step: CommandStep): Promise<string>;
  exists(path: string): Promise<boolean>;
  readJson(path: string): Promise<unknown>;
  /** Writes the whole file at once (a temporary file, then a rename). */
  writeJson(path: string, value: unknown): Promise<void>;
  env(name: string): string | undefined;
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
  print(line: string): void;
}

/** Carries out a deployment plan step by step, or, in a dry run, prints every step without doing it. */
export class Deployment {
  private change: JobListChange | null = null;

  constructor(
    private readonly machine: MachineConfig,
    private readonly ports: DeployPorts,
    private readonly options: { commit: string; dryRun: boolean },
  ) {}

  async run(steps: readonly Step[]): Promise<void> {
    for (const [index, step] of steps.entries()) {
      this.ports.print(`[${index + 1}/${steps.length}] ${step.title}`);
      await this.perform(step);
    }
    this.ports.print(this.options.dryRun ? "Dry run: nothing was changed." : "Deployed.");
  }

  private async perform(step: Step): Promise<void> {
    switch (step.kind) {
      case "command":
        return this.command(step);
      case "fresh-release":
        return this.freshRelease(step.path);
      case "require-env":
        return this.requireEnv(step.name);
      case "switch-jobs":
        return this.switchJobs(step.source);
      case "restart":
        return this.restart();
      case "health":
        return this.health();
    }
  }

  private async command(step: CommandStep): Promise<void> {
    this.ports.print(
      `  $ ${[step.command, ...step.args].join(" ")}${step.cwd ? `  (in ${step.cwd})` : ""}`,
    );
    if (!this.options.dryRun) {
      await this.ports.run(step);
    }
  }

  private async freshRelease(path: string): Promise<void> {
    if (await this.ports.exists(path)) {
      throw deployErrors.create("DEPLOY.RELEASE_EXISTS", { details: { path } });
    }
  }

  private async requireEnv(name: string): Promise<void> {
    if (!this.ports.env(name) && !this.options.dryRun) {
      throw deployErrors.create("DEPLOY.ENV_MISSING", { details: { name } });
    }
  }

  /** The current list is backed up before the new one replaces it; a dry run only reads and reports. */
  private async switchJobs(source: string): Promise<void> {
    const { file, backups } = this.machine.jobList;
    const current = await this.ports.readJson(file);
    const change = nextJobList(current, this.machine, source);
    this.change = change;
    this.ports.print(`  changed: ${change.changed.join(", ") || "none"}`);
    this.ports.print(`  removed (old code, stopped): ${change.removed.join(", ") || "none"}`);
    const backup = `${backups}/deployment.before-${this.options.commit.slice(0, 12)}-${stamp(this.ports.now())}.json`;
    this.ports.print(`  backup: ${backup}`);
    if (!this.options.dryRun) {
      await this.ports.writeJson(backup, current);
      await this.ports.writeJson(file, change.next);
    }
  }

  /** Removed jobs are stopped; changed jobs are stopped and started from the new release. Nothing else restarts. */
  private async restart(): Promise<void> {
    const change = this.change ?? { changed: [], removed: [] };
    for (const id of change.removed) {
      await this.command(this.control("stop", id));
    }
    for (const id of change.changed) {
      await this.command(this.control("stop", id));
      await this.command(this.control("start", id));
    }
  }

  private async health(): Promise<void> {
    if (this.options.dryRun) {
      this.ports.print("  (checked after a real deployment)");
      return;
    }
    const ids = this.machine.jobs.map((job) => job.id);
    const { attempts, intervalMs } = this.machine.health;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const answers = await Promise.all(
        ids.map((id) => this.ports.run(this.control("status", id))),
      );
      if (jobsHealthy(ids, answers)) {
        return;
      }
      await this.ports.sleep(intervalMs);
    }
    throw deployErrors.create("DEPLOY.UNHEALTHY", { details: { jobs: ids } });
  }

  private control(action: "stop" | "start" | "status", id: string): CommandStep {
    const { node } = this.machine.tools;
    const args = [this.machine.jobList.control, action, id];
    return { kind: "command", title: `${action} ${id}`, command: node, args };
  }
}

function stamp(time: Date): string {
  return time.toISOString().replaceAll(/[-:]/g, "").replace(/\..*$/, "");
}
