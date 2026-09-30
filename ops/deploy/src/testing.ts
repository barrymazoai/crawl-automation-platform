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
    jobList: {
      file: "/srv/crawler/live/deployment.json",
      control: "/srv/crawler/manual-control.mjs",
      backups: "/srv/crawler/manual-releases",
    },
    jobs: [
      { id: "collection-api", app: "api", env: { V3_API_CONFIG: "/srv/private/api.json" } },
      {
        id: "pipeline-worker",
        app: "worker",
        process: "pipeline",
        env: { V3_PIPELINE_CONFIG: "/srv/private/worker.json" },
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

/** A machine in memory: records every command and write; status answers come from `ready`. */
export function fakeMachine(jobList: unknown, ready: (id: string) => boolean = () => true) {
  const commands: string[] = [];
  const writes: { path: string; value: unknown }[] = [];
  const lines: string[] = [];
  const existing = new Set<string>();
  const migrations: { source: string; settings: MachineConfig["migrations"] }[] = [];
  const ports: DeployPorts = {
    run: async (step: CommandStep) => {
      commands.push([step.command, ...step.args].join(" "));
      const [, action, id] = step.args;
      return action === "status" && id ? JSON.stringify({ jobs: [{ id, ready: ready(id) }] }) : "";
    },
    exists: async (path) => existing.has(path),
    readJson: async () => jobList,
    writeJson: async (path, value) => {
      writes.push({ path, value });
    },
    env: (name) => (name === "V3_DATABASE_URL" ? "postgres://placeholder" : undefined),
    now: () => new Date("2026-09-30T01:02:03.000Z"),
    sleep: async () => undefined,
    print: (line) => lines.push(line),
    migrate: async (source, settings) => {
      migrations.push({ source, settings });
    },
  };
  return { ports, commands, writes, lines, existing, migrations };
}
