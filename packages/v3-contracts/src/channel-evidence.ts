import { z } from "zod";
import { ExecutionIdSchema } from "./artifacts.js";
export const ChannelNameSchema = z.enum(["amazon", "swanson", "dtc"]);
const url = z.string().url().max(4096);
export const ChannelEntrySchema = z.strictObject({ listingId: ExecutionIdSchema, variantId: ExecutionIdSchema.nullable(), url,
  title: z.string().max(4000).nullable() });
export const ChannelCatalogEvidenceSchema = z.strictObject({ codec: z.literal("channel-catalog/1"), channel: ChannelNameSchema,
  url, entries: z.array(ChannelEntrySchema).max(2000), nextUrl: url.nullable(),
  completion: z.enum(["more", "unverified_end"]), reportedTotal: z.number().int().nonnegative().nullable(),
  warnings: z.array(z.string().max(100)).max(20) });
export const ChannelProductEvidenceSchema = z.strictObject({ codec: z.literal("channel-product/1"), channel: ChannelNameSchema,
  listingId: ExecutionIdSchema, variantId: ExecutionIdSchema.nullable(), url, title: z.string().min(1).max(4000), brandRaw: z.string().max(1000).nullable(),
  variantOptions: z.array(z.string().max(500)).max(10), variants: z.array(ChannelEntrySchema).max(200),
  detailsHtml: z.string().max(2000000).nullable(),
  factsCandidates: z.array(z.strictObject({ field: z.string().max(100), html: z.string().max(500000),
    scope: z.enum(["selected-product", "product-unassigned-variant"]) })).max(8),
  imageCandidates: z.array(z.strictObject({ url, variantId: ExecutionIdSchema.nullable(),
    basis: z.enum(["selected-gallery", "product-gallery", "variant-featured"]), verifiedOriginal: z.literal(false) })).max(100),
  warnings: z.array(z.string().max(100)).max(20) });
export type ChannelProductEvidence = z.infer<typeof ChannelProductEvidenceSchema>;
export type ChannelCatalogEvidence = z.infer<typeof ChannelCatalogEvidenceSchema>;
