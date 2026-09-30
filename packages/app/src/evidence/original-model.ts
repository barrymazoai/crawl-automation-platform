import { ChannelIdSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { SavedHtmlOriginal } from "../pipeline/html-capture-records.js";

const IdentifierSchema = z.string().min(1).max(200);

/** An operation, or the latest saved original for one exact listing/variant identity. */
export const EvidenceOriginalInputSchema = z.union([
  z.strictObject({ operationId: IdentifierSchema }),
  z.strictObject({
    channel: ChannelIdSchema,
    listingId: IdentifierSchema,
    variantId: IdentifierSchema.nullable().optional(),
  }),
]);
export type EvidenceOriginalInput = z.infer<typeof EvidenceOriginalInputSchema>;

/** The selected operation can be a consumer of an older producer's original. */
export interface OriginalCaptureRecord {
  operationId: string;
  original: SavedHtmlOriginal;
}

export interface OriginalCaptureReader {
  find(input: EvidenceOriginalInput): Promise<OriginalCaptureRecord | null>;
}

export interface EvidenceOriginalResult {
  operationId: string;
  channel: SavedHtmlOriginal["channel"];
  listingId: string;
  variantId: string | null;
  capturedAt: string;
  url: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
  html: string;
}
