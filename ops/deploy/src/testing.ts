import { JobService, type JobDefinition, type JobRunner } from "@crawl-automation/app";
import { releaseJobs } from "./job-list.js";
import type { CommandStep } from "./deploy-plan.js";
import type { DeployPorts } from "./deployment.js";
import { MachineConfigSchema, type MachineConfig } from "./machine-config.js";

export const COMMIT = "68adac2a1b2c3d4e5f60718293a4b5c6d7e8f901";

/** Server 一's deployment, with placeholder paths only. */
export function serverOne(changes: Partial<Record<string, unknown>> = {}): MachineConfig {
  return MachineConfigSchema.parse({
    machine: "server-one",
    repository: "git@example.test:crawler.git",
    root: "/srv/crawler",
    tools: { node: "/opt/node", pnpm: "/opt/pnpm", git: "/usr/bin/git" },
    pm2: {
      file: "/srv/crawler/live/ecosystem.json",
      backups: "/srv/crawler/manual-releases",
    },
    jobs: [
      {
        id: "collection-api",
        app: "api",
        env: { V3_API_CONFIG: "/srv/private/api.json" },
        healthFile: "/srv/health/api.json",
        logs: { out: "/srv/logs/api.out", error: "/srv/logs/api.err" },
      },
      {
        id: "pipeline-worker",
        app: "worker",
        process: "pipeline",
        env: { V3_PIPELINE_CONFIG: "/srv/private/worker.json" },
        healthFile: "/srv/health/pipeline.json",
        logs: { out: "/srv/logs/pipeline.out", error: "/srv/logs/pipeline.err" },
      },
    ],
    migrations: {
      backups: "/srv/private/backups",
      confirm: "database.example.test:55432/crawler_v3_dev",
    },
    health: { attempts: 2, intervalMs: 500 },
    ...changes,
  });
}

/** A machine in memory; the real job service orchestrates a fake process runner and file. */
export function fakeMachine(
  previous: JobDefinition[] = [],
  ready: (id: string) => boolean = () => true,
) {
  const commands: string[] = [];
  const writes: { path: string; value: unknown }[] = [];
  const lines: string[] = [];
  const existing = new Set<string>();
  const migrations: { source: string; settings: MachineConfig["migrations"] }[] = [];
  const runner = fakeRunner(previous, commands, ready);
  const ports: DeployPorts = {
    run: async (step: CommandStep) => {
      commands.push([step.command, ...step.args].join(" "));
      return "";
    },
    exists: async (path) => existing.has(path),
    jobs: async (machine, source, dryRun) => {
      const service = fakeJobService({ machine, previous, writes, runner });
      const request = { jobs: releaseJobs(machine, source), health: machine.health };
      if (dryRun) {
        lines.push(JSON.stringify(await service.preview(request)));
      } else {
        await service.deploy(request);
      }
    },
    env: (name) => (name === "V3_DATABASE_URL" ? "postgres://placeholder" : undefined),
    print: (line) => lines.push(line),
    migrate: async (source, settings) => {
      migrations.push({ source, settings });
    },
  };
  return { ports, commands, writes, lines, existing, migrations, runner };
}

function fakeRunner(
  previous: JobDefinition[],
  commands: string[],
  ready: (id: string) => boolean,
): JobRunner {
  const record = async (action: string) => {
    commands.push(action);
  };
  return {
    connect: () => record("connect"),
    disconnect: () => record("disconnect"),
    list: async () => previous.map((job) => job.name),
    stop: (name) => record(`stop ${name}`),
    remove: (name) => record(`remove ${name}`),
    start: async (job) => {
      await record(`start ${job.name}`);
      return { pid: 123, startedAt: 1_000 };
    },
    health: async (job) => ({
      name: job.name,
      ready: ready(job.name),
      reason: ready(job.name) ? "ready" : "stopped",
    }),
  };
}

function fakeJobService(options: {
  machine: MachineConfig;
  previous: JobDefinition[];
  writes: { path: string; value: unknown }[];
  runner: JobRunner;
}) {
  const { machine, previous, writes, runner } = options;
  return new JobService({
    runner,
    sleep: async () => undefined,
    file: {
      read: async () => previous,
      replace: async (jobs) => {
        const backup = `${machine.pm2.backups}/previous.json`;
        writes.push({ path: backup, value: previous }, { path: machine.pm2.file, value: jobs });
        return { backup };
      },
    },
  });
}
