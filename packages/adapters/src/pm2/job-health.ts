import { recordRecovery } from "@crawl-automation/platform";
import { readFile } from "node:fs/promises";
import type { JobDefinition, JobHealth, JobStart } from "@crawl-automation/app";
import type { ProcessDescription } from "pm2";
import { z } from "zod";

const heartbeatSchema = z.object({
  event: z.literal("WORKER_RUNNING"),
  role: z.string(),
  pid: z.number().int().positive(),
  reportedAt: z.iso.datetime(),
});

export interface HealthObservation {
  job: JobDefinition;
  process: ProcessDescription | undefined;
  start?: JobStart;
  now: number;
  bytes: string | null;
}

export function jobHealth(observation: HealthObservation): JobHealth {
  const { job, now, bytes } = observation;
  const result = (reason: string): JobHealth => ({
    name: job.name,
    ready: reason === "ready",
    reason,
  });
  const runtime = runningProcess(observation);
  if (typeof runtime === "string") {
    return result(runtime);
  }
  const heartbeat = parseHeartbeat(bytes);
  if (!heartbeat) {
    return result("health-missing-or-invalid");
  }
  const role = job.env.V3_WORKER_PROCESS ? `${job.env.V3_WORKER_PROCESS}-worker` : "api";
  if (heartbeat.role !== role || heartbeat.pid !== runtime.pid) {
    return result("health-identity-mismatch");
  }
  const reported = Date.parse(heartbeat.reportedAt);
  if (reported <= runtime.startedAt || reported > now || now - reported >= 15_000) {
    return result("health-outside-start-window");
  }
  return result("ready");
}

function runningProcess({ process, start }: HealthObservation): JobStart | string {
  if (!process) {
    return "process-not-running";
  }
  const environment = process.pm2_env ?? {};
  const uptime = environment.pm_uptime;
  if (environment.status !== "online" || !process.pid || !uptime) {
    return "process-not-running";
  }
  if (start && (start.pid !== process.pid || uptime !== start.startedAt)) {
    return "process-changed-since-start";
  }
  return { pid: process.pid, startedAt: uptime };
}

function parseHeartbeat(bytes: string | null) {
  try {
    const result = heartbeatSchema.safeParse(JSON.parse(bytes ?? "null"));
    return result.success ? result.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      recordRecovery(error, { operation: "job.health.parse" });
      return null;
    }
    throw error;
  }
}

export async function readHealthFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      // ENOENT is an absent optional status file; all other I/O errors propagate.
      return null;
    }
    throw error;
  }
}
