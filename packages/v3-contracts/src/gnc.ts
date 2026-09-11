import { z } from "zod";
import { ExecutionIdSchema } from "./artifacts.js";
import { SourceBindingSchema } from "./acquisition.js";
export const GncUrlSchema = z.string().max(4096).refine(raw => {
  try { const u = new URL(raw); return u.protocol === "https:" && u.hostname === "www.gnc.com" && !u.port && !u.username && !u.password && !u.hash; }
  catch { return false; }
}, "Only explicit public GNC HTTPS URLs");
const common = { requestId: ExecutionIdSchema, operationId: ExecutionIdSchema, brandId: ExecutionIdSchema,
  sourceId: ExecutionIdSchema, binding: SourceBindingSchema, url: GncUrlSchema };
export const GncCaptureInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("catalog-page") }),
  z.strictObject({ ...common, kind: z.literal("product"), sku: z.string().regex(/^\d{6}$/) }),
]).refine(i => {
  if (i.kind !== "product") return true;
  try { return new URL(i.url).pathname.endsWith(`/${i.sku}.html`); } catch { return false; }
}, "Product URL must identify the requested SKU");
export type GncCaptureInput = z.infer<typeof GncCaptureInputSchema>;
export const GncProductEvidenceSchema = z.strictObject({ sku: z.string().regex(/^\d{6}$/), url: GncUrlSchema,
  title: z.string().min(1).max(4000), brandRaw: z.string().max(1000).nullable(),
  factsHtml: z.string().max(2000000).nullable(), detailsHtml: z.string().max(2000000).nullable(),
  variantUrls: z.array(GncUrlSchema).max(200),
  imageCandidates: z.array(z.strictObject({ url: z.string().url().max(4096),
    basis: z.enum(["sku-jsonld", "product-gallery"]), verifiedOriginal: z.literal(false) })).max(100),
  warnings: z.array(z.enum(["GNC.FACTS_DOM_MISSING", "GNC.GALLERY_UNVERIFIED", "GNC.BRAND_MISSING"])).max(3),
});
export type GncProductEvidence = z.infer<typeof GncProductEvidenceSchema>;
export const GncCatalogPageSchema = z.strictObject({ url: GncUrlSchema,
  entries: z.array(z.strictObject({ url: GncUrlSchema, kind: z.enum(["sku", "family"]), sku: z.string().regex(/^\d{6}$/).nullable() })).max(1000),
  nextUrl: GncUrlSchema.nullable(), completion: z.enum(["more", "unverified_end"]),
  countProof: z.strictObject({ codec:z.literal("gnc-single-page-count/1"), count:z.number().int().min(1).max(100) }).optional(),
});
export type GncCatalogPage = z.infer<typeof GncCatalogPageSchema>;
