import { z } from "zod";
import type { HarvestRecord, CaptureReview } from "./product-record.js";
import { captureFile, type CaptureFile } from "./archive.js";
import { materialHtml } from "./capture-materials.js";

export const MaterialScopeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    variantId: z.string().min(1),
    status: z.literal("unresolved"),
    reason: z.string().min(1),
  }),
  z.strictObject({
    variantId: z.string().min(1),
    status: z.enum(["independent", "mixed"]),
    reason: z.string().min(1),
    pageHtml: z.string().min(1),
    productHtml: z.string().min(1),
    galleryUrls: z.array(z.url()).min(1).max(100),
  }),
]);
type ResolvedScope = Exclude<z.infer<typeof MaterialScopeSchema>, { status: "unresolved" }>;
interface ScopeInput {
  root: string;
  record: HarvestRecord;
  review: CaptureReview;
  files: CaptureFile[];
}

/** Map saved variant pages and images directly; product content is processed downstream. */
export async function scopedHarvestRecord(input: ScopeInput, variantId: string) {
  const scope = readScope(input, variantId);
  const variant = input.record.variants.find((item) => item.variantId === variantId);
  if (!variant?.url) {
    throw new Error("material_variant_address_missing");
  }
  const gallery = input.record.gallery.filter((image) => scope.galleryUrls.includes(image.url));
  if (
    gallery.length !== scope.galleryUrls.length ||
    new Set(scope.galleryUrls).size !== gallery.length
  ) {
    throw new Error("material_gallery_incomplete_or_unknown");
  }
  const detailsHtml = await materialHtml(input, scope.productHtml);
  await materialHtml(input, scope.pageHtml);
  const html = await captureFile(input.root, scope.pageHtml);
  const record: HarvestRecord = {
    ...input.record,
    productUrl: variant.url,
    fields: variantMetadata(input.record, variant),
    gallery,
    pageHtml: scope.pageHtml,
  };
  const evidence = ["materials.json", scope.pageHtml, scope.productHtml];
  const review: CaptureReview = {
    ...input.review,
    selectedVariantId: variantId,
    galleryUrls: scope.galleryUrls,
    evidence,
    imageAssignments: scope.galleryUrls.map((url) => ({
      url,
      variantId: scope.status === "mixed" ? null : variantId,
      basis: "product-gallery",
    })),
  };
  const status = scope.status === "mixed" ? ("mixed" as const) : ("observed" as const);
  return { record, review, html, detailsHtml, context: { status, evidence, reason: scope.reason } };
}

function variantMetadata(record: HarvestRecord, variant: HarvestRecord["variants"][number]) {
  const fields = { ...record.fields };
  for (const name of ["sku", "price", "currency"] as const) {
    if (variant[name] !== undefined) {
      fields[name] = variant[name];
    }
  }
  return fields;
}

function readScope(input: ScopeInput, variantId: string): ResolvedScope {
  const raw = (input.review.materialScopes ?? []).filter(
    (entry) =>
      entry && typeof entry === "object" && "variantId" in entry && entry.variantId === variantId,
  );
  if (raw.length > 1) {
    throw new Error("variant_material_scope_duplicate");
  }
  const scope = raw[0] === undefined ? null : MaterialScopeSchema.parse(raw[0]);
  if (scope && scope.status !== "unresolved") {
    return scope;
  }
  return mixedFallback(input, scope?.reason ?? "variant_material_scope_missing");
}

/**
 * A variant without its own resolved materials uses the product's base page and full gallery as a mixed
 * scope (owner 2026-10-05). The existing mixed-gallery step then assigns or shares its Facts, or reviews it.
 */
function mixedFallback(input: ScopeInput, reason: string): ResolvedScope {
  const pageHtml =
    typeof input.record.pageHtml === "string"
      ? input.record.pageHtml
      : input.record.pageHtml.localPath;
  // capturedMaterials records the base product region as the evidence entry after materials.json.
  const productHtml = input.review.evidence.find((path) => path !== "materials.json") ?? pageHtml;
  return {
    variantId: "fallback",
    status: "mixed",
    reason: `base materials used: ${reason}`.slice(0, 4000),
    pageHtml,
    productHtml,
    galleryUrls: input.record.gallery.map((image) => image.url),
  };
}
