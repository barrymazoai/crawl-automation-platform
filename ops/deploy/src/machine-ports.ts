import { access } from "node:fs/promises";
import { join } from "node:path";
import { MigrationService } from "@crawl-automation/app";
import {
  loadSqlCatalog,
  parseMigrationConnection,
  PostgresMigrationRepository,
} from "@crawl-automation/adapters";
import type { Logger } from "@crawl-automation/platform";
import { execa } from "execa";
import type { CommandStep } from "./deploy-plan.js";
import type { DeployPorts } from "./deployment.js";
import { deployErrors } from "./deploy-errors.js";
import { runMachineJobs } from "./job-health.js";

/** Capture the environment once. A dry run never constructs a database connection. */
export function createMachinePorts(logger: Logger): DeployPorts {
  const environment = { ...process.env };
  return {
    run: runCommand,
    exists: (path) =>
      access(path).then(
        () => true,
        () => false,
      ),
    jobs: (machine, source, dryRun) =>
      runMachineJobs(machine, source, { dryRun, print: (line) => logger.info(line) }),
    env: (name) => environment[name],
    print: (line) => logger.info(line),
    async migrate(source, settings) {
      const value = environment.V3_DATABASE_URL;
      if (!value) {
        throw deployErrors.create("DEPLOY.ENV_MISSING", { details: { name: "V3_DATABASE_URL" } });
      }
      const connection = parseMigrationConnection(value);
      const catalog = await loadSqlCatalog(join(source, "database/v3"));
      const repository = new PostgresMigrationRepository({
        connection,
        catalog,
        logger,
        ...(settings.pgDump ? { pgDump: settings.pgDump } : {}),
      });
      const result = await new MigrationService(repository).migrate({
        confirmation: settings.confirm,
        backupDirectory: settings.backups,
      });
      logger.info({ migration: result }, "database migration verified");
    },
  };
}

async function runCommand(step: CommandStep): Promise<string> {
  const result = await execa(step.command, step.args, {
    ...(step.cwd ? { cwd: step.cwd } : {}),
    ...(step.env ? { env: step.env } : {}),
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw deployErrors.create("DEPLOY.COMMAND_FAILED", {
      details: {
        command: step.title,
        exitCode: result.exitCode ?? null,
        stderr: tail(result.stderr),
      },
    });
  }
  return String(result.stdout);
}

/** The last lines of a command's error output, for the failure report. */
function tail(text: unknown): string {
  return String(text ?? "")
    .split("\n")
    .slice(-20)
    .join("\n");
}
