import { z } from "zod";
import { brandScanErrors } from "@crawl-automation/channels-core";
import { ScanChannelSchema, type ScanResult } from "./scan-model.js";

/** Supplied selectors intersect. Refuse an accidental unscoped cancellation. */
export const CancelScansSchema = z
  .strictObject({
    scanIds: z.array(z.uuid()).min(1).max(1_000).optional(),
    requestId: z.uuid().optional(),
    channel: ScanChannelSchema.optional(),
  })
  .refine((query) => !!(query.scanIds || query.requestId || query.channel), {
    message: "Name scan IDs, a request ID or a channel",
  });
export type CancelScans = z.infer<typeof CancelScansSchema>;
export interface CancelScanCounts {
  cancelled: number;
  cancellationRequested: number;
}

export function emptyScanResult(): ScanResult {
  return {
    state: "review",
    pages: 0,
    products: 0,
    families: 0,
    unresolvedFamilies: 0,
    statedTotal: null,
    full: false,
    capped: false,
    newListings: null,
    knownListings: null,
    missing: 0,
    queued: 0,
    credits: 0,
    code: null,
  };
}

/** Already committed queue batches and archived evidence remain truthful after cancellation. */
export function cancelledScanResult(result: ScanResult = emptyScanResult()): ScanResult {
  return {
    ...result,
    state: "cancelled",
    full: false,
    cooldownRequested: false,
    code: brandScanErrors.code("BRAND_SCAN.CANCELLED"),
  };
}

/** Cooperative boundary: never interrupt a paid download or its archive publication. */
export async function checkScanCancellation(
  store: { isCancellationRequested(scanId: string): Promise<boolean> },
  scanId: string,
): Promise<void> {
  if (await store.isCancellationRequested(scanId)) {
    throw brandScanErrors.create("BRAND_SCAN.CANCELLED");
  }
}
