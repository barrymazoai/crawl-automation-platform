import { z } from "zod";
import { ObjectKeySchema, Sha256Schema, ExecutionIdSchema } from "./artifacts.js";
import { ChannelPlanInputSchema } from "./channel-plan.js";
import { DtcVariantHandoffsSchema } from "./dtc-variants.js";
import { OcrInputSchema } from "./processing.js";
import { ChannelProductEvidenceSchema } from "./channel-evidence.js";

/**
 * DTC-only prepass. It never changes the shared Facts or OCR result contracts. A retained ref may be as large as a DTC
 * page (6 MiB, DTC_PAGE_LIMITS; owner 2026-10-08: PureTrim pages are ~2.08 MB, over the earlier 2 MB).
 */
export const DtcGalleryRefSchema = z.strictObject({
  objectKey: ObjectKeySchema, sha256: Sha256Schema, byteSize: z.number().int().positive().max(6 * 1024 * 1024),
});
export const DtcGalleryRequestSchema = z.strictObject({
  sourcePlan: ChannelPlanInputSchema,
  variants: DtcVariantHandoffsSchema,
});
export const DtcGalleryTaskSchema = DtcGalleryRequestSchema.extend({
  websiteVariants: ChannelProductEvidenceSchema.shape.variants,
  images: z.array(z.strictObject({ url: z.url(), input: OcrInputSchema })).min(1).max(100),
  // Gallery files OCR cannot read (e.g. SVG badges on Tally, 2026-10-06), kept out of attribution and listed here.
  unreadable: z.array(z.strictObject({ url: z.url(), mediaType: z.string().min(1).max(200) })).max(100).optional(),
});
export const DtcGalleryDecisionSchema = z.strictObject({
  kind: z.enum(["facts", "other", "unresolved"]),
  variantIds: z.array(z.string().min(1)).max(200),
  basis: z.enum(["label-content", "website-shared", "scope-unassigned", "unresolved", "not-facts"]),
  reason: z.string().min(1).max(8000),
  /** Verbatim image/OCR and website evidence, retained for review; not a formula-equivalence claim. */
  imageEvidence: z.string().max(16000),
  websiteEvidence: z.string().max(16000),
});
export const DtcGalleryImageRequestSchema = z.strictObject({
  task: DtcGalleryRefSchema, imageId: ExecutionIdSchema,
});
export const DtcGalleryFinishSchema = z.strictObject({
  task: DtcGalleryRefSchema, decisions: z.array(DtcGalleryRefSchema).min(1).max(100),
  selections: z.array(DtcGalleryRefSchema).max(200).optional(),
});
export type DtcGalleryRef = z.infer<typeof DtcGalleryRefSchema>;
export type DtcGalleryTask = z.infer<typeof DtcGalleryTaskSchema>;
export type DtcGalleryDecision = z.infer<typeof DtcGalleryDecisionSchema>;
