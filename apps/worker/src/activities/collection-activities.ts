import { PostgresBrandScans } from "@crawl-automation/adapters";
import { RunScans } from "@crawl-automation/app";
import { CollectionScanRequestSchema } from "@crawl-automation/workflows";
import type { WorkerParts } from "../container.js";
import { guarded } from "./activity-guard.js";

/** The brand-run (CollectionWorkflow) activity: reads the run's brand scan; it never starts or pays for anything. */
export function collectionActivities(parts: WorkerParts) {
  const scans = new RunScans(new PostgresBrandScans(parts.database));
  const handlers = {
    brandScanOf: (raw: unknown) => scans.scanOf(CollectionScanRequestSchema.parse(raw)),
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [name, guarded(name, handler, parts.log)]),
  );
}
