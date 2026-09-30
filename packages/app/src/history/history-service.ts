import { ChannelIdSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";

/** A listing's history by its channel's own product ID (ASIN, SKU, handle); metrics unless `formula` is asked. */
export const HistoryQuerySchema = z.strictObject({
  channel: ChannelIdSchema,
  externalId: z.string().trim().min(1).max(200),
  kind: z.enum(["metrics", "formula"]).default("metrics"),
  limit: z.number().int().min(1).max(500).default(100),
});
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

/** A listing the history holds under that product ID. */
export interface HistoryListingRef {
  historyListingId: string;
  site: string | null;
  externalId: string | null;
  basis: string;
}

/** One point of a listing's history, newest first: what was observed, when, as it was recorded. */
export interface HistoryPoint {
  observationId: string;
  historyListingId: string;
  observedAt: string | null;
  record: Record<string, unknown>;
}

export interface HistoryAnswer {
  listings: HistoryListingRef[];
  points: HistoryPoint[];
}

/** Reads the append-only history tables. */
export interface ProductHistoryReader {
  find(query: HistoryQuery): Promise<HistoryAnswer>;
}

/** A listing's metrics (or formula) history, read only. */
export class HistoryService {
  constructor(private readonly deps: { history: ProductHistoryReader }) {}

  async list(raw: unknown): Promise<HistoryAnswer> {
    return this.deps.history.find(HistoryQuerySchema.parse(raw));
  }
}
