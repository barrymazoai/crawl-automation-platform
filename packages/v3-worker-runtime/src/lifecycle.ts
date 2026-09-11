import { randomUUID } from "node:crypto";
import { parseWorkerConfig } from "./config.js";
import type { WorkerConfig } from "./config.js";
import type { PreparedRole, RoleDefinition, RoleRegistry } from "./registry.js";

export interface WorkerHandle {
  run(): Promise<void>;
  shutdown(): void;
  getState(): string;
}
export interface WorkerConnection {
  create(prepared: PreparedRole, role: Readonly<RoleDefinition>, config: WorkerConfig, queue: string, identity: string): Promise<WorkerHandle>;
  close(): Promise<void>;
}
export interface RuntimePorts {
  connect(config: WorkerConfig): Promise<WorkerConnection>;
  report(event: Record<string, string | number>): void;
}
export class UnsafeWorkerExit extends Error {
  constructor() { super("Worker did not stop safely; process exit required, do not dispose live module resources"); }
}

export async function runRegisteredWorker(input: unknown, registry: RoleRegistry, ports: RuntimePorts, signal: AbortSignal) {
  const parsed = parseWorkerConfig(input);
  const config = Object.freeze({ ...parsed, transport: Object.freeze(parsed.transport) });
  // Every check happens before opening connections or creating provider clients.
  const { role, taskQueue } = registry.select(config);
  const identity = `${config.hostId}/${role.role}/${randomUUID()}/${role.buildId}`;
  if (signal.aborted) return;
  let connection: WorkerConnection | undefined;
  let prepared: PreparedRole | undefined;
  let unsafe = false;
  try {
    connection = await ports.connect(config);
    if (signal.aborted) return;
    prepared = await role.prepare(config, signal);
    if (prepared.kind !== role.kind ||
        (prepared.kind === "workflow" && "activities" in prepared) ||
        (prepared.kind === "activity" && ("workflowBundle" in prepared || Object.keys(prepared.activities).length === 0 ||
          Object.values(prepared.activities).some(fn => typeof fn !== "function")))) throw new Error("Role factory violated its isolated capability");
    if (signal.aborted) return;
    const worker = await connection.create(prepared, role, config, taskQueue, identity);
    let stopping = false;
    const stop = () => {
      if (!stopping && worker.getState() === "RUNNING") {
        stopping = true;
        ports.report({ event: "WORKER_DRAINING", role: role.role, identity });
        worker.shutdown();
      }
    };
    // SDK run enters RUNNING synchronously. Attach abort listener and re-check to close the startup race.
    const running = worker.run();
    signal.addEventListener("abort", stop);
    if (signal.aborted) stop();
    try {
      ports.report({ event: "WORKER_RUNNING", role: role.role, kind: role.kind, taskQueue, identity,
        buildId: role.buildId, contractVersion: role.contractVersion, mode: registry.mode });
      await running;
    } finally {
      signal.removeEventListener("abort", stop);
      // Forced SDK shutdown may leave JS Activity callbacks running. Do not close their resources underneath them.
      unsafe = worker.getState() !== "STOPPED";
    }
    if (unsafe) throw new UnsafeWorkerExit();
    ports.report({ event: "WORKER_STOPPED", role: role.role, identity });
  } catch (error) {
    if (unsafe) throw new UnsafeWorkerExit();
    throw error;
  } finally {
    if (!unsafe) {
      try { await prepared?.dispose(); }
      finally { await connection?.close(); }
    }
  }
}
