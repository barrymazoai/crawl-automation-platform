import { fleetIssue, jobStatus } from "./status-health.js";
import type { FleetStatus, FleetStatusPorts, TaskQueueKind } from "./status-ports.js";

export * from "./status-ports.js";
export { fleetIssue } from "./status-health.js";

/** Legacy file-adapter types, retained only until that unused adapter is deleted. */
export interface WorkerState {
  id: string;
  ready: boolean;
}

export interface FleetSnapshot {
  /** When the health monitor last wrote its status. */
  checkedAt: string | null;
  monitorRunning: boolean;
  workers: WorkerState[];
}

export interface QueueHealth {
  checkedAt: string | null;
  canStart: boolean;
  reasons: string[];
}

export interface FleetStatusSource {
  fleet(): Promise<FleetSnapshot>;
  queueHealth(): Promise<QueueHealth>;
}

/** Read-only observations of this machine, all configured worker queues, and the OCR API. */
export class FleetService {
  constructor(private readonly deps: FleetStatusPorts) {}

  async status(): Promise<FleetStatus> {
    const ocrRequest = this.ocrHealth();
    const local = await this.localJobs();
    const names = [
      ...new Set([...this.deps.queueNames, ...local.jobs.flatMap((job) => job.queues)]),
    ];
    const taskQueues = await Promise.all(
      names.flatMap((name) =>
        (["workflow", "activity"] as const).map((kind) => this.pollers(name, kind)),
      ),
    );
    const ocr = await ocrRequest;
    const now = (this.deps.now ?? Date.now)();
    return {
      checkedAt: new Date(now).toISOString(),
      local: { jobs: local.jobs.map((job) => jobStatus(job, now)), error: local.error },
      taskQueues,
      ocr,
    };
  }

  private async localJobs() {
    try {
      return { jobs: await this.deps.jobs.list(), error: null };
    } catch (error) {
      return { jobs: [], error: fleetIssue(error) };
    }
  }

  private async pollers(name: string, kind: TaskQueueKind) {
    try {
      return { name, kind, pollers: await this.deps.taskQueues.describe(name, kind), error: null };
    } catch (error) {
      return { name, kind, pollers: [], error: fleetIssue(error) };
    }
  }

  private async ocrHealth() {
    try {
      return await this.deps.ocr.health();
    } catch (error) {
      return {
        configured: true,
        healthy: false,
        statusCode: null,
        body: null,
        error: fleetIssue(error),
      };
    }
  }
}
