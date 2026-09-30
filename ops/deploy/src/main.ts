#!/usr/bin/env -S pnpm exec tsx
import { AppError, createLogger, loadConfig } from "@crawl-automation/platform";
import { Command } from "commander";
import { deployPlan } from "./deploy-plan.js";
import { Deployment } from "./deployment.js";
import { MachineConfigSchema } from "./machine-config.js";
import { createMachinePorts } from "./machine-ports.js";
import { deployErrors } from "./deploy-errors.js";

const logger = createLogger({ name: "deploy" });

/**
 * The one deploy command, run by hand on the machine being deployed:
 *   crawler-deploy <machine-config> <commit> [--migrate] [--dry-run]
 * It clones origin at a commit of `main` into a fresh release, installs, builds, optionally upgrades the database,
 * switches the machine's job list (backing it up first), restarts only the jobs that changed, and checks health.
 * It never copies code from another machine and never installs anything that starts at boot or login.
 */
const program = new Command()
  .name("crawler-deploy")
  .argument("<machine-config>", "this machine's private deployment file (absolute path)")
  .argument("<commit>", "a full commit of origin main")
  .option("--migrate", "validate, back up and migrate the database before switching", false)
  .option("--dry-run", "print every step without doing it", false)
  .action(
    async (configPath: string, commit: string, flags: { migrate: boolean; dryRun: boolean }) => {
      const machine = await loadConfig(MachineConfigSchema, configPath);
      const steps = deployPlan(machine, { commit, migrate: flags.migrate });
      const machinePorts = createMachinePorts(logger.child({ runId: commit }));
      await new Deployment(machine, machinePorts, { commit, dryRun: flags.dryRun }).run(steps);
    },
  );

program.parseAsync().catch((error: unknown) => {
  const failure =
    error instanceof AppError
      ? error
      : deployErrors.create("DEPLOY.UNEXPECTED_FAILURE", { cause: error });
  logger.error({ code: failure.code, details: failure.details }, "deployment stopped");
  process.exitCode = 1;
});
