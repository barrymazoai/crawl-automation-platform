import { z } from "zod";
import type { HarvestRecord, CaptureReview } from "./product-record.js";
import type { CaptureFile } from "./archive.js";

const proof = {
  variantId: z.string().min(1),
  reason: z.string().min(1).max(8000),
  evidence: z.array(z.string().min(1)).min(1).max(200),
};
export const MaterialScopeSchema = z.union([
  z.strictObject({ ...proof, status: z.literal("unresolved") }),
  z.strictObject({
    ...proof,
    status: z.enum(["independent", "mixed"]),
    fields: z
      .array(
        z.strictObject({
          field: z.string().min(1),
          sourceField: z.string().min(1),
          // null means the complete original field. Substrings must be verbatim, never model rewrites.
          quote: z.string().min(1).nullable(),
        }),
      )
      .max(100),
    galleryUrls: z.array(z.url()).min(1).max(100),
  }),
]);

interface ScopeInput {
  record: HarvestRecord;
  review: CaptureReview;
  files: CaptureFile[];
  evidenceFiles?: CaptureFile[];
}
type MaterialScope = Exclude<z.infer<typeof MaterialScopeSchema>, { status: "unresolved" }>;

/** Fixed conversion AFTER raw harvest and material judgment. No browser, extraction or guessed fields. */
export function scopedHarvestRecord(input: ScopeInput, variantId: string) {
  const scope = readScope(input, variantId);
  const variant = input.record.variants.find((item) => item.variantId === variantId);
  if (!variant?.url) {
    throw new Error("material_variant_address_missing");
  }
  const gallery = scopedGallery(input.record, scope);
  const fields = scopedFields(input.record, scope.fields);
  // Website inventory is authoritative. Only this exact variant supplies its own commercial values.
  for (const name of ["sku", "price"] as const) {
    if (variant[name] !== undefined) {
      fields[name] = variant[name];
    }
  }
  const { fieldEvidence: _method, ...base } = input.record;
  const record: HarvestRecord = { ...base, productUrl: variant.url, fields, gallery };
  return {
    record,
    review: materialReview(input.review, scope),
    context: {
      status: scope.status === "mixed" ? ("mixed" as const) : ("observed" as const),
      evidence: scope.evidence,
      reason: scope.reason,
    },
  };
}

function readScope(input: ScopeInput, variantId: string) {
  const raw = (input.review.materialScopes ?? []).filter(
    (entry) =>
      entry && typeof entry === "object" && "variantId" in entry && entry.variantId === variantId,
  );
  if (raw.length !== 1) {
    throw new Error("variant_material_scope_missing_or_duplicate");
  }
  const scope = MaterialScopeSchema.parse(raw[0]);
  const known = new Set((input.evidenceFiles ?? input.files).map((file) => file.path));
  if (scope.evidence.some((path) => !known.has(path))) {
    throw new Error("material_evidence_not_retained");
  }
  if (scope.status === "unresolved") {
    throw new Error(scope.reason);
  }
  return scope;
}

function scopedGallery(record: HarvestRecord, scope: MaterialScope) {
  const gallery = record.gallery.filter((image) => scope.galleryUrls.includes(image.url));
  if (
    gallery.length !== scope.galleryUrls.length ||
    new Set(scope.galleryUrls).size !== gallery.length ||
    (scope.status === "mixed" && gallery.length !== record.gallery.length)
  ) {
    throw new Error("material_gallery_incomplete_or_unknown");
  }
  return gallery;
}

function materialReview(review: CaptureReview, scope: MaterialScope): CaptureReview {
  return {
    ...review,
    selectedVariantId: scope.variantId,
    galleryUrls: scope.galleryUrls,
    detailCoveragePath: undefined,
    evidence: scope.evidence,
    imageAssignments: scope.galleryUrls.map((url) => ({
      url,
      variantId: scope.status === "mixed" ? null : scope.variantId,
      basis: "product-gallery",
    })),
  };
}

function scopedFields(record: HarvestRecord, selected: MaterialScope["fields"]) {
  const fields: Record<string, unknown> = Object.fromEntries(
    Object.entries(record.fields).filter(([name]) => ["title", "brand", "currency"].includes(name)),
  );
  for (const item of selected) {
    if (Object.hasOwn(fields, item.field) || ["sku", "price", "images"].includes(item.field)) {
      throw new Error("material_field_duplicate_or_reserved");
    }
    const source = record.fields[item.sourceField];
    if (
      typeof source !== "string" ||
      !source.trim() ||
      (item.quote !== null && !source.includes(item.quote))
    ) {
      throw new Error("material_field_not_in_raw_capture");
    }
    fields[item.field] = item.quote ?? source;
  }
  return fields;
}
