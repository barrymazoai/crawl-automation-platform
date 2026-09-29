import { z } from "zod";
import { QueueChannelSchema } from "../queue/queue-model.js";

/** Channels whose brand scans go through the shared queue (Amazon keeps its own tools until 5.5). */
export const ScanChannelSchema = QueueChannelSchema.exclude(["amazon"]);
export type ScanChannel = z.infer<typeof ScanChannelSchema>;

/** Channels whose brand scans need a browser (owner decision): their scanner must be configured to scan them. */
export const BROWSER_SCAN_CHANNELS: readonly ScanChannel[] = ["wholefoods"];

/**
 * Scans to start: the named brand sources, or every enabled source of a channel. The request ID makes asking
 * twice start each source's scan once.
 */
export const RequestScansSchema = z
  .strictObject({
    requestId: z.uuid(),
    sourceIds: z.array(z.uuid()).min(1).max(1_000).optional(),
    channel: ScanChannelSchema.optional(),
  })
  .refine((request) => !!request.sourceIds !== !!request.channel, {
    message: "Name either the sources or a channel (all its enabled sources)",
  });
export type RequestScans = z.infer<typeof RequestScansSchema>;

export const ScanStateSchema = z.enum(["queued", "running", "complete", "partial", "review"]);
export type ScanState = z.infer<typeof ScanStateSchema>;

export const ScanListQuerySchema = z.strictObject({
  channel: ScanChannelSchema.optional(),
  state: ScanStateSchema.optional(),
  limit: z.number().int().min(1).max(1_000).default(100),
});
export type ScanListQuery = z.infer<typeof ScanListQuerySchema>;

/** A brand source a scan reads. */
export interface ScanSource {
  sourceId: string;
  brandId: string;
  brandName: string;
  channel: string;
  url: string;
  enabled: boolean;
}

/** What a finished scan found. `full` means the pages proved every product of the brand was listed. */
export interface ScanResult {
  state: Exclude<ScanState, "queued" | "running">;
  pages: number;
  products: number;
  families: number;
  unresolvedFamilies: number;
  statedTotal: number | null;
  full: boolean;
  /** Known listings a full scan no longer showed; each is queued for a direct revisit. */
  missing: number;
  queued: number;
  credits: number;
  code: string | null;
}

/** One brand scan: its source, its state and, once finished, what it found. */
export interface ScanRecord {
  scanId: string;
  requestId: string;
  source: ScanSource;
  /** The shared-queue list the scan's revisits go into (fixed at request time, so a rerun queues them once). */
  revisitBatchId: string;
  state: ScanState;
  result: ScanResult | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
