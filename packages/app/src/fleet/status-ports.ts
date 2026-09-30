export interface FleetIssue {
  code: string | number | null;
  message: string;
}

export interface WorkerHeartbeat {
  process: string;
  pid: number;
  running: boolean;
  lastHeartbeat: string;
}

/** Observations only; freshness and readiness are decided by the service. */
export interface FleetJobObservation {
  name: string | null;
  status: string;
  pid: number;
  restarts: number;
  startedAt: number | null;
  process: string;
  queues: string[];
  heartbeat: WorkerHeartbeat | null;
  issues: FleetIssue[];
}

export interface FleetJobStatus extends Omit<
  FleetJobObservation,
  "heartbeat" | "process" | "queues"
> {
  /** Milliseconds since this live process started; zero for a stopped process. */
  uptimeMs: number | null;
  health: {
    process: string;
    queues: string[];
    running: boolean | null;
    pid: number | null;
    lastHeartbeat: string | null;
    stale: boolean;
    ready: boolean;
    reason: string;
  };
}

export type TaskQueueKind = "workflow" | "activity";

export interface TaskQueuePoller {
  identity: string;
  lastAccessTime: string | null;
  ratePerSecond: number | null;
}

export interface FleetTaskQueues {
  describe(name: string, kind: TaskQueueKind): Promise<TaskQueuePoller[]>;
}

export interface OcrHealth {
  configured: boolean;
  healthy: boolean;
  statusCode: number | null;
  body: Record<string, unknown> | null;
  error: FleetIssue | null;
}

export interface FleetStatusPorts {
  jobs: { list(): Promise<FleetJobObservation[]> };
  taskQueues: FleetTaskQueues;
  queueNames: readonly string[];
  ocr: { health(): Promise<OcrHealth> };
  now?: () => number;
}

export interface FleetStatus {
  checkedAt: string;
  local: { jobs: FleetJobStatus[]; error: FleetIssue | null };
  taskQueues: {
    name: string;
    kind: TaskQueueKind;
    pollers: TaskQueuePoller[];
    error: FleetIssue | null;
  }[];
  ocr: OcrHealth;
}
