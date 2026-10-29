import { CHANNEL_IDS } from "@crawl-automation/v3-contracts";
import { z } from "zod";

/**
 * Crawl rounds for Supply Smart's Data updates page (KAN-229). Nothing in the crawler records a "round": the owner
 * starts one by scanning every brand of a channel (or by queueing a large hand list such as a history recapture), so a
 * round is a burst of product lists with a quiet gap before the next burst.
 */
export const RoundQuerySchema = z.strictObject({
  since: z.iso.datetime(),
  channel: z.enum(CHANNEL_IDS).optional(),
  /** A list created this long after the previous round's last start begins a new round. */
  gapHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(72),
  /** A hand list (not a brand scan) starts a round only with this many products; smaller ones are follow-ups. */
  startListItems: z.number().int().min(1).max(100_000).default(100),
});
export type RoundQuery = z.infer<typeof RoundQuerySchema>;

/** One product list (link_batch) with the current states of the queue items it added. */
export interface RoundBatchRow {
  channel: string;
  batchId: string;
  createdAt: string;
  /** scan: a brand scan's listing; revisit: known listings a full scan no longer showed; list: added by hand. */
  kind: "scan" | "revisit" | "list";
  items: number;
  /** Current states: a requeued item is open again until its new run settles. */
  open: number;
  completed: number;
  review: number;
  /** Items whose first run has not settled; later requeues never keep a round open. */
  firstOpen: number;
  /** When the last first run settled. */
  firstSettledAt: string | null;
}

export interface RoundScanRow {
  channel: string;
  sourceId: string;
  requestedAt: string;
  finishedAt: string | null;
  state: "queued" | "running" | "complete" | "partial" | "review" | "cancelled";
}

/** Products the crawler sent to Supply Smart under one ingest run id (marketplace sync or a DTC delivery). */
export interface RoundPushRow {
  channel: string;
  runId: string;
  at: string;
  verified: number;
  failed: number;
  sent: number;
}

export interface RoundSnapshot {
  readAt: string;
  batches: RoundBatchRow[];
  scans: RoundScanRow[];
  pushes: RoundPushRow[];
}

export interface RoundReader {
  read(input: { since: string; channel?: string | undefined }): Promise<RoundSnapshot>;
}

export interface CrawlRound {
  channel: string;
  /** `<channel>-<first start, to the minute>`; stable once the round has started. */
  roundId: string;
  startedAt: string;
  /** Set once every product's first run and every brand scan of the round have settled. */
  finishedAt: string | null;
  /** The next round's start, or null for the latest round: pushes up to here count for this round. */
  windowEnd: string | null;
  /** Scans of the round (a source scanned again counts again) and the distinct brand sources they read. */
  brandScans: {
    total: number;
    sources: number;
    complete: number;
    partial: number;
    review: number;
    cancelled: number;
    open: number;
  };
  lists: { scan: number; revisit: number; list: number };
  /** Distinct queue items by current state; open includes items requeued after the round. */
  products: { targets: number; completed: number; review: number; open: number };
  pushed: { verified: number; failed: number; sent: number; runIds: string[] };
}
