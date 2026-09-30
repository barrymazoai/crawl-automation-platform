import type { CommandStep, Step } from "./deploy-plan.js";
import { deployErrors } from "./deploy-errors.js";
import type { MachineConfig } from "./machine-config.js";

/** Everything the deployment does to the machine, behind one port so a dry run and tests touch nothing. */
export interface DeployPorts {
  /** Runs a command to completion; fails on a non-zero exit. Returns its standard output. */
  run(step: CommandStep): Promise<string>;
  exists(path: string): Promise<boolean>;
  jobs(machine: MachineConfig, source: string, dryRun: boolean): Promise<void>;
  env(name: string): string | undefined;
  print(line: string): void;
  migrate(source: string, settings: NonNullable<MachineConfig["migrations"]>): Promise<void>;
}

/** Carries out a deployment plan step by step, or, in a dry run, prints every step without doing it. */
export class Deployment {
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
      case "migrate":
        return this.migrate(step.source);
      case "jobs":
        return this.ports.jobs(this.machine, step.source, this.options.dryRun);
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

  private async migrate(source: string): Promise<void> {
    const settings = this.machine.migrations;
    if (!settings) {
      throw deployErrors.create("DEPLOY.MIGRATIONS_NOT_CONFIGURED");
    }
    this.ports.print(`  SQL: ${source}/database/v3; backup parent: ${settings.backups}`);
    if (!this.options.dryRun) {
      await this.ports.migrate(source, settings);
    }
  }
}
