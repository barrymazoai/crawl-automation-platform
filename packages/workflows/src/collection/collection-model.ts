import { z } from "zod";

/** The workflow type a brand run starts (the API's delivery target); no other type is accepted there. */
export const COLLECTION_WORKFLOW = "CollectionWorkflow";

/** The brand scan a brand run waits for, as its activity reads it from the scan table. */
export const CollectionScanSchema = z.strictObject({
  scanId: z.uuid(),
  state: z.enum(["queued", "running", "complete", "partial", "review", "cancelled"]),
  /** Products the finished scan put into the shared queue; null while it runs. */
  queued: z.number().int().min(0).nullable(),
  /** Why a scan ended in Review; null otherwise. */
  code: z.string().nullable(),
});
export type CollectionScan = z.infer<typeof CollectionScanSchema>;

export const CollectionScanRequestSchema = z.strictObject({
  requestId: z.uuid(),
  sourceId: z.uuid(),
});
export type CollectionScanRequest = z.infer<typeof CollectionScanRequestSchema>;

/** A brand run's result once its scan finished: every listed product is in the shared queue. */
export interface CollectionResult {
  codec: "collection-settled/1";
  requestId: string;
  scanId: string;
  state: "complete" | "partial" | "review" | "cancelled";
  queued: number;
  code: string | null;
}

export interface CollectionActivities {
  /** The run's brand scan (requested by the API when the run was accepted). */
  brandScanOf(request: CollectionScanRequest): Promise<CollectionScan>;
}

/** The activity's code for a run without its brand scan (registered in the app's error registry). */
export const SCAN_MISSING = "RUN.SCAN_MISSING";

/** Scans still running are asked again after this long. */
export const SCAN_POLL = "30 seconds";
/** A read of the scan table failing this many times in a row ends the run (nothing paid is repeated). */
export const MAX_READ_FAILURES = 10;
