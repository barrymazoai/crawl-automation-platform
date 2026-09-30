import type { JobDefinition } from "@crawl-automation/app";
import type { ProcessDescription, StartOptions } from "pm2";
import type { Pm2Api } from "./pm2-client.js";

export const STARTED = Date.parse("2026-09-30T01:00:00Z");

export function exampleJob(name = "pipeline-worker"): JobDefinition {
  return {
    name,
    script: "/release/apps/worker/dist/main.js",
    args: ["--label", "two words"],
    cwd: "/release",
    interpreter: "/opt/node",
    env: {
      V3_WORKER_PROCESS: "pipeline",
      V3_PIPELINE_CONFIG: "/private/worker.json",
      V3_WORKER_HEALTH_FILE: `/health/${name}.json`,
    },
    outFile: `/logs/${name}.out`,
    errorFile: `/logs/${name}.err`,
  };
}

/** Callback-level fake: exercises the actual PM2 adapter, including describe/list verification. */
export class FakePm2 implements Pm2Api {
  readonly events: string[] = [];
  readonly processes = new Map<string, ProcessDescription>();
  readonly starts: StartOptions[] = [];
  private nextId = 1;

  connect(callback: Parameters<Pm2Api["connect"]>[0]): void {
    this.events.push("connect");
    callback(null);
  }

  disconnect(): void {
    this.events.push("disconnect");
  }

  list(callback: Parameters<Pm2Api["list"]>[0]): void {
    this.events.push("list");
    callback(null, [...this.processes.values()]);
  }

  describe(name: string, callback: Parameters<Pm2Api["describe"]>[1]): void {
    this.events.push(`describe:${name}`);
    const process = this.processes.get(name);
    callback(null, process ? [process] : []);
  }

  start(options: StartOptions, callback: Parameters<Pm2Api["start"]>[1]): void {
    const name = options.name ?? "unnamed";
    this.events.push(`start:${name}`);
    this.starts.push(options);
    const id = this.nextId++;
    this.processes.set(name, {
      name,
      pm_id: id,
      pid: id + 100,
      pm2_env: { status: "online", pm_uptime: STARTED },
    });
    callback(null);
  }

  stop(id: number, callback: Parameters<Pm2Api["stop"]>[1]): void {
    const process = this.byId(id);
    this.events.push(`stop:${process.name}`);
    process.pid = 0;
    process.pm2_env = { ...process.pm2_env, status: "stopped" };
    callback(null);
  }

  delete(id: number, callback: Parameters<Pm2Api["delete"]>[1]): void {
    const process = this.byId(id);
    this.events.push(`delete:${process.name}`);
    this.processes.delete(process.name ?? "");
    callback(null);
  }

  private byId(id: number): ProcessDescription {
    const process = [...this.processes.values()].find((entry) => entry.pm_id === id);
    if (!process) {
      throw new Error(`unknown fake process: ${id}`);
    }
    return process;
  }
}
