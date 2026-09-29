import { readFile } from "node:fs/promises";
import type { FleetSnapshot, FleetStatusSource, QueueHealth } from "@crawl-automation/app";
import { differenceInSeconds } from "date-fns";
import { z } from "zod";

/** The health monitor rewrites its status every 5 seconds; older than this means it is not running. */
const MONITOR_FRESH_SECONDS = 30;

const MonitorStatus = z.object({
  at: z.string(),
  status: z.string().optional(),
  jobs: z.array(z.object({ id: z.string(), ready: z.boolean() })),
});

const QueueHealthFile = z.object({
  at: z.string(),
  canStart: z.boolean(),
  reasons: z.array(z.string()),
});

export interface FleetStatusPaths {
  /** The health monitor's `status.json`. */
  monitorStatus: string;
  /** The Amazon queue health gate's `health.json`. */
  queueHealth: string;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Reads the status files the health monitor and the queue health gate write. */
export class FleetStatusFiles implements FleetStatusSource {
  constructor(
    private readonly paths: FleetStatusPaths,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fleet(): Promise<FleetSnapshot> {
    const parsed = MonitorStatus.safeParse(await readJson(this.paths.monitorStatus));
    if (!parsed.success) {
      return { checkedAt: null, monitorRunning: false, workers: [] };
    }
    const { at, status, jobs } = parsed.data;
    const fresh = differenceInSeconds(this.now(), new Date(at)) <= MONITOR_FRESH_SECONDS;
    return {
      checkedAt: at,
      monitorRunning: fresh && status !== "monitor-stopped",
      workers: jobs.map((job) => ({ id: job.id, ready: job.ready })),
    };
  }

  async queueHealth(): Promise<QueueHealth> {
    const parsed = QueueHealthFile.safeParse(await readJson(this.paths.queueHealth));
    if (!parsed.success) {
      return { checkedAt: null, canStart: false, reasons: ["HEALTH_FILE_UNREADABLE"] };
    }
    return {
      checkedAt: parsed.data.at,
      canStart: parsed.data.canStart,
      reasons: parsed.data.reasons,
    };
  }
}
