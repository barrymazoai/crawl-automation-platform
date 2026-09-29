import { UNLISTED_REASONS } from "@crawl-automation/channels-core";
import { z } from "zod";
import { QueueChannelSchema, QueuedProductSchema } from "../queue/queue-model.js";

/**
 * What a direct revisit showed about a known listing (docs/quality/2026-09-18-product-service-listing-state-prompt.md):
 * `unlisted` (with the reason) or `live` (still on sale). Owner rule 2026-09-29, every channel: a redirect to a
 * different product is unlisted, and every unlisted sighting records exactly why. The crawler records each sighting as
 * a fact; only the product database decides whether a listing is delisted.
 */
export const ListingStateSchema = z.enum(["unlisted", "live"]);
export type ListingState = z.infer<typeof ListingStateSchema>;

export const UnlistedReasonSchema = z.enum(UNLISTED_REASONS);
export type UnlistedReasonName = z.infer<typeof UnlistedReasonSchema>;

const listingId = z.string().min(1).max(200);

export const ListingEvidenceSchema = z.strictObject({
  /** How the state was seen; `direct-revisit` is a product run fetching the listing's own page. */
  probe: z.enum(["direct-revisit"]),
  causeCode: z.string().min(1).max(120),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  /** The other product the page belongs to now; required for `redirected_to_other_product` and `identity_conflict`. */
  observedExternalId: listingId.nullable(),
  /** Where a redirect landed; required for `redirected_to_other_product` and `redirected_away`. */
  finalUrl: z.url().max(2048).nullable(),
  /** Where the page that showed it is archived in R2, when one was archived. */
  artifactKey: z.string().min(1).max(1024).nullable(),
});
export type ListingEvidence = z.infer<typeof ListingEvidenceSchema>;

/** One sighting to record. `source` names what saw it; with the listing it is the observation's identity. */
export const ListingSightingInputSchema = z.strictObject({
  channel: QueueChannelSchema,
  listingId,
  variantId: listingId.nullable(),
  brandId: z.uuid().nullable(),
  runId: z.uuid().nullable(),
  state: ListingStateSchema,
  /** Why the listing is unlisted; null exactly when it is `live`. */
  reason: UnlistedReasonSchema.nullable(),
  evidence: ListingEvidenceSchema,
  source: z.string().min(1).max(300),
  capturedAt: z.iso.datetime(),
});
export type ListingSightingInput = z.infer<typeof ListingSightingInputSchema>;

/** A recorded sighting, and whether it has been sent to the product database. */
export interface ListingObservation extends ListingSightingInput {
  observationId: string;
  registeredAt: string;
  deliveredAt: string | null;
}

export const ListingQuerySchema = z.strictObject({
  channel: QueueChannelSchema,
  brandId: z.uuid().optional(),
  listingId: listingId.optional(),
  state: ListingStateSchema.optional(),
  reason: UnlistedReasonSchema.optional(),
  limit: z.number().int().min(1).max(1000).default(200),
});
export type ListingQuery = z.infer<typeof ListingQuerySchema>;

export const ListingCountsQuerySchema = ListingQuerySchema.pick({ channel: true, brandId: true });
export type ListingCountsQuery = z.infer<typeof ListingCountsQuerySchema>;

/** Sightings per state and per unlisted reason, and how many are still waiting to be sent. */
export interface ListingCounts {
  channel: string;
  byState: Record<ListingState, number>;
  byReason: Record<UnlistedReasonName, number>;
  undelivered: number;
}

/**
 * Listings a full brand scan no longer showed. Absence is never a delisting: each one is queued for a direct
 * revisit, and that revisit's sighting decides. Only a full scan may ask for this (a partial scan, such as an
 * Amazon search capped at 7 pages, never does).
 */
export const MissingFromScanSchema = z.strictObject({
  channel: QueueChannelSchema.exclude(["amazon"]),
  scope: z.literal("full"),
  /** The revisit list's ID (e.g. derived from the scan's ID), so asking twice queues once. */
  batchId: z.uuid(),
  label: z.string().min(1).max(200),
  listings: z.array(QueuedProductSchema).min(1).max(10_000),
});
export type MissingFromScan = z.infer<typeof MissingFromScanSchema>;
