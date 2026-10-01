import { z } from "zod";
import type { ListingPage } from "./listing-model.js";
import type { ListingPageRead, ListingPageRequest } from "./listing-fetch-model.js";

/** Per-observation accounting survives partial and failed reads in the scan's JSON result. */
export const ListingScanMetricsSchema = z.object({
  storeId: z.string(),
  /** Successful observations and catalogue agreement are distinct; absent in older records. */
  readsFinished: z.boolean().optional(),
  catalogueAgreement: z.boolean().optional(),
  attempts: z.array(
    z.object({
      read: z.string(),
      page: z.number().int(),
      attempt: z.number().int(),
      url: z.string(),
      archiveKey: z.string().nullable(),
      creditCost: z.number().nullable(),
      fromArchive: z.boolean(),
      empty: z.boolean().nullable(),
      code: z.string().nullable(),
    }),
  ),
  reads: z.array(
    z.object({
      read: z.string(),
      pages: z.number().int(),
      cards: z.number().int(),
      products: z.number().int(),
      availableCounts: z.array(z.number()),
      succeeded: z.boolean(),
      code: z.string().nullable(),
    }),
  ),
  unionSize: z.number().int(),
});
export type ListingScanMetrics = z.infer<typeof ListingScanMetricsSchema>;
export type ListingPolicyRequest = Omit<ListingPageRequest, "scanId" | "channel" | "origins">;

/** A channel's bounded observation policy uses only the shared archived read and cancellable pause. */
export interface ListingScanContext {
  sourceUrl: string;
  signal: AbortSignal;
  read(request: ListingPolicyRequest): Promise<ListingPageRead>;
  pause(milliseconds: number): Promise<void>;
}

export interface ListingScanOutcome {
  pages: ListingPage[];
  credits: number;
  complete: boolean;
  statedTotal: number | null;
  soldHere?: boolean;
  cooldownRequested: boolean;
  code: string | null;
  metrics: ListingScanMetrics;
}
