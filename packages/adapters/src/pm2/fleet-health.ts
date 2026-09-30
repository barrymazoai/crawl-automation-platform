import { fleetIssue, type FleetIssue, type WorkerHeartbeat } from "@crawl-automation/app";
import { z } from "zod";
import { readHealthFile } from "./job-health.js";

const heartbeatSchema = z.object({
  event: z.enum(["WORKER_RUNNING", "WORKER_STOPPED"]),
  role: z.string().min(1),
  pid: z.number().int().positive(),
  reportedAt: z.iso.datetime(),
});
const workerQueuesSchema = z.object({
  taskQueue: z.string().min(1).optional(),
  processes: z
    .record(z.string(), z.object({ roles: z.array(z.object({ taskQueue: z.string().min(1) })) }))
    .optional(),
});

export interface FleetFileReader {
  read(path: string): Promise<string | null>;
}

/** Read only the heartbeat and queue names; private worker configuration never leaves this adapter. */
export class Pm2FleetFiles {
  constructor(private readonly files: FleetFileReader = { read: readHealthFile }) {}

  async heartbeat(path: string | null): Promise<{
    heartbeat: WorkerHeartbeat | null;
    issues: FleetIssue[];
  }> {
    try {
      const parsed = heartbeatSchema.parse(await this.json(path));
      return {
        heartbeat: {
          process: parsed.role.replace(/-worker$/, ""),
          pid: parsed.pid,
          running: parsed.event === "WORKER_RUNNING",
          lastHeartbeat: parsed.reportedAt,
        },
        issues: [],
      };
    } catch (error) {
      return { heartbeat: null, issues: [fleetIssue(error)] };
    }
  }

  async queues(path: string | null, process: string) {
    if (path === null) {
      return { queues: [], issues: [] };
    }
    try {
      const config = workerQueuesSchema.parse(await this.json(path));
      const roles = config.processes?.[process]?.roles;
      const queues = roles?.map((role) => role.taskQueue) ?? [];
      if (!config.processes && config.taskQueue) {
        queues.push(config.taskQueue);
      }
      return { queues: [...new Set(queues)], issues: [] };
    } catch (error) {
      return { queues: [], issues: [fleetIssue(error)] };
    }
  }

  private async json(path: string | null): Promise<unknown> {
    return JSON.parse(path === null ? "null" : ((await this.files.read(path)) ?? "null"));
  }
}
