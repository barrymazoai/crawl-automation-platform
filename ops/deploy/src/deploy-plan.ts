import { deployErrors } from "./deploy-errors.js";
import { APPS, type MachineConfig } from "./machine-config.js";

export interface CommandStep {
  kind: "command";
  title: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** A step that needs state only known while deploying (the directory, the job list, the operator's env). */
export type Step =
  | CommandStep
  | { kind: "fresh-release"; title: string; path: string }
  | { kind: "require-env"; title: string; name: string }
  | { kind: "migrate"; title: string; source: string }
  | { kind: "jobs"; title: string; source: string };

export interface DeployOptions {
  /** A full commit of origin `main`. */
  commit: string;
  /** Upgrade the database through the in-process service before the jobs switch. */
  migrate: boolean;
}

/** Where a release lives: `<root>/releases/<commit>/source`. */
export function releaseSource(machine: Pick<MachineConfig, "root">, commit: string): string {
  return `${machine.root}/releases/${commit}/source`;
}

/**
 * Every step of one deployment, in order: a fresh clone of origin at the commit (which must be on `main`), a locked
 * install, the builds the machine's jobs need, optionally the database upgrade, then the job list switch, a restart
 * of the jobs that changed, and a health check. Nothing is copied from another machine.
 */
export function deployPlan(machine: MachineConfig, options: DeployOptions): Step[] {
  if (!/^[0-9a-f]{40}$/.test(options.commit)) {
    throw deployErrors.create("DEPLOY.COMMIT_INVALID", { details: { commit: options.commit } });
  }
  const source = releaseSource(machine, options.commit);
  const { git, pnpm } = machine.tools;
  const gitStep = (title: string, args: string[]): CommandStep => command(title, git, args);
  const apps = [...new Set(machine.jobs.map((job) => job.app))];
  return [
    { kind: "fresh-release", title: "Check the release directory is new", path: source },
    gitStep("Clone origin", ["clone", "--no-checkout", machine.repository, source]),
    gitStep("Check the commit is on main", [
      "-C",
      source,
      "merge-base",
      "--is-ancestor",
      options.commit,
      "origin/main",
    ]),
    gitStep("Check out the commit", ["-C", source, "checkout", "--detach", options.commit]),
    {
      ...command("Install locked dependencies", pnpm, ["install", "--frozen-lockfile"]),
      cwd: source,
    },
    ...apps.map((app) => ({
      ...command(`Build ${app}`, pnpm, ["--filter", APPS[app].filter, "build"]),
      cwd: source,
    })),
    ...(options.migrate ? migrationSteps(machine, source) : []),
    { kind: "jobs", title: "Write the PM2 file, replace changed jobs and wait for ready", source },
  ];
}

function command(title: string, executable: string, args: string[]): CommandStep {
  return { kind: "command", title, command: executable, args };
}

/** One service call owns validation, backup, migration and recheck under the same lock. */
function migrationSteps(machine: MachineConfig, source: string): Step[] {
  const settings = machine.migrations;
  if (!settings) {
    throw deployErrors.create("DEPLOY.MIGRATIONS_NOT_CONFIGURED");
  }
  return [
    { kind: "require-env", title: "Check V3_DATABASE_URL is set", name: "V3_DATABASE_URL" },
    { kind: "migrate", title: "Validate, back up, migrate and recheck the database", source },
  ];
}
