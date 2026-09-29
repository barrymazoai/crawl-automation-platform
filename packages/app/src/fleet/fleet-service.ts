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

export interface FleetStatus extends FleetSnapshot {
  ready: number;
  notReady: string[];
  queue: QueueHealth;
}

/** Which worker processes are up, and whether the queue may start new work (with its reasons). */
export class FleetService {
  constructor(private readonly deps: { source: FleetStatusSource }) {}

  async status(): Promise<FleetStatus> {
    const [fleet, queue] = await Promise.all([
      this.deps.source.fleet(),
      this.deps.source.queueHealth(),
    ]);
    const notReady = fleet.workers.filter((worker) => !worker.ready).map((worker) => worker.id);
    return { ...fleet, ready: fleet.workers.length - notReady.length, notReady, queue };
  }
}
