import type { Logger } from "@crawl-automation/platform";
import type { FleetStatusPorts, FleetTaskQueues } from "../fleet/status-ports.js";

export interface ResourceHealthTarget {
  taskQueues: string[];
  ocr?: boolean | undefined;
  browser?: boolean | undefined;
}

export interface ResourceHealthOptions {
  controller: string;
  intervalMs: number;
  ttlMs: number;
  minFreeBytes: number;
  diskPath: string;
  resources: Record<string, ResourceHealthTarget>;
}

export type ResourceHealthReason =
  | "ready"
  | `browser:${string}`
  | `no_pollers:${string}`
  | "ocr_unhealthy"
  | "disk_low"
  | "monitor_stopping";

export interface ResourceHealthWrite {
  resourceId: string;
  controller: string;
  healthy: boolean;
  ttlMs: number;
  reason: ResourceHealthReason;
}

export interface ResourceHealthRepository {
  /** Returns the number of matching rows; never inserts or changes ownership. */
  write(state: ResourceHealthWrite): Promise<number>;
}

export interface ResourceHealthPorts {
  browser?: { reason(resourceId: string): Promise<string | null> };
  repository: ResourceHealthRepository;
  taskQueues: FleetTaskQueues;
  ocr: FleetStatusPorts["ocr"];
  disk: { freeBytes(path: string): Promise<number> };
  log: Logger;
}
