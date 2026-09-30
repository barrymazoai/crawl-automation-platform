import { ScraperApiOptionsSchema } from "@crawl-automation/platform";
import { ArtifactRefSchema, CHANNEL_IDS, type ArtifactRef } from "@crawl-automation/v3-contracts";
import { z } from "zod";

/** One page download for one capture operation. */
export const HtmlCaptureSchema = z.strictObject({
  operationId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  url: z.url().max(4096),
  sourceId: z.string().min(1).max(200),
  listingId: z.string().min(1).max(200),
  variantId: z.string().min(1).max(200).nullable(),
});
export type HtmlCapture = z.infer<typeof HtmlCaptureSchema>;

/** Earlier receipts lack options and creditCost and remain readable. */
export const FetchedViaSchema = z.strictObject({
  mode: z.enum(["http", "browser"]),
  storeId: z
    .string()
    .regex(/^\d{1,12}$/)
    .optional(),
  routeId: z.string(),
  egressId: z.string(),
  provider: z.string(),
  options: ScraperApiOptionsSchema.omit({ headers: true }).optional(),
  creditCost: z.number().nonnegative().nullable().optional(),
  finalUrl: z.url().max(4096).optional(),
});
export type FetchedVia = z.infer<typeof FetchedViaSchema>;

export interface ArchivedHtml {
  bytes: Uint8Array;
  source: ArtifactRef;
  capturedAt: string;
  url: string;
  finalUrl: string | null;
}

export const HtmlCaptureRequestSchema = z.strictObject({
  channel: z.enum(CHANNEL_IDS),
  capture: HtmlCaptureSchema,
});
export type HtmlCaptureRequest = z.infer<typeof HtmlCaptureRequestSchema>;

/** References the producer's receipt and bytes; reuse never substitutes the consuming operation. */
export const SavedHtmlOriginalSchema = HtmlCaptureRequestSchema.extend({
  source: ArtifactRefSchema.refine((source) => source.kind === "source-html"),
  capturedAt: z.iso.datetime(),
  finalUrl: z.url().max(4096).nullable(),
}).refine(
  ({ capture, source }) =>
    source.sourceId === capture.sourceId &&
    source.listingId === capture.listingId &&
    source.variantId === capture.variantId &&
    source.producer.operationId === capture.operationId,
);
export type SavedHtmlOriginal = z.infer<typeof SavedHtmlOriginalSchema>;
