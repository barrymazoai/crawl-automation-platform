import { readObservedVariant } from "../../../../../crawl-products/lib/observed-variant.mjs";
import { isDeepStrictEqual } from "node:util";
import { captureFile, type CaptureFile } from "./archive.js";
import { verifyMethod, type HarvestRecord, type CaptureReview } from "./product-record.js";
import { VariantContextSchema, type ObservedVariantContext } from "./variant-review.js";
import { sha256 } from "@crawl-automation/platform";

export interface VariantRecordInput {
  root: string;
  files: CaptureFile[];
  evidenceFiles?: CaptureFile[];
  record: HarvestRecord;
  review: CaptureReview;
}

/** Read only archived, model-selected sources. No navigation, inference or generic extraction. */
export async function readVariantRecord(input: VariantRecordInput, variantId: string) {
  const context = readContext(input, variantId);
  if (context.status === "unresolved") {
    throw new Error(context.reason);
  }
  const method = await captureFile(input.root, context.methodPath);
  if (
    !input.files.some((file) => file.path === context.methodPath && file.sha256 === sha256(method))
  ) {
    throw new Error("variant_method_not_archived");
  }
  const sourceMethod = JSON.parse(method.toString());
  const observed = await readObservedVariant(input.root, input.record, context, sourceMethod);
  await verifyPreflight(input, context, sourceMethod);
  verifyGallery(input, context);
  const record: HarvestRecord = {
    ...input.record,
    ...observed,
    productUrl: observed.sourceUrl,
    // The inventory remains the verified base capture's exact website inventory.
    variants: input.record.variants,
    gallery: input.record.gallery.filter((image) => context.galleryUrls.includes(image.url)),
  };
  await verifyMethod(input, record);
  const review: CaptureReview = {
    ...input.review,
    selectedVariantId: variantId,
    galleryUrls: context.galleryUrls,
    evidence: context.evidence,
    imageAssignments: context.galleryUrls.map((url) => ({
      url,
      variantId,
      basis: "product-gallery",
    })),
  };
  return { record, review, context };
}

function readContext(input: VariantRecordInput, variantId: string) {
  const candidates = (input.review.variantContexts ?? []).filter(
    (raw) => raw && typeof raw === "object" && "variantId" in raw && raw.variantId === variantId,
  );
  if (candidates.length !== 1) {
    throw new Error("variant_context_missing_or_duplicate");
  }
  const context = VariantContextSchema.parse(candidates[0]);
  const proof = input.evidenceFiles ?? input.files;
  const evidence =
    context.status === "observed"
      ? [...context.evidence, ...context.galleryReview.flatMap((image) => image.evidence)]
      : context.evidence;
  if (evidence.some((path) => !proof.some((file) => file.path === path))) {
    throw new Error("variant_evidence_not_archived");
  }
  return context;
}

async function verifyPreflight(
  input: VariantRecordInput,
  context: ObservedVariantContext,
  method: unknown,
) {
  const bytes = await captureFile(input.root, "variant-preflight.json");
  if (
    !input.files.some(
      (file) => file.path === "variant-preflight.json" && file.sha256 === sha256(bytes),
    )
  ) {
    throw new Error("variant_preflight_not_archived");
  }
  const preflight = JSON.parse(bytes.toString());
  const matches = preflight.contexts?.filter(
    (entry: { context?: { variantId?: string } }) => entry.context?.variantId === context.variantId,
  );
  if (
    matches?.length !== 1 ||
    !isDeepStrictEqual(matches[0].context, context) ||
    !isDeepStrictEqual(matches[0].method, method) ||
    matches[0].passed !== true
  ) {
    throw new Error("variant_preflight_context_changed");
  }
}

function verifyGallery(input: VariantRecordInput, context: ObservedVariantContext) {
  if (
    context.galleryReview.some(
      (image) =>
        image.status === "applicable" &&
        image.basis === "website-binding" &&
        !input.review.imageAssignments.some(
          (binding) => binding.url === image.url && binding.variantId === context.variantId,
        ),
    )
  ) {
    throw new Error("variant_gallery_website_binding_missing");
  }
  if (
    new Set(context.galleryUrls).size !== context.galleryUrls.length ||
    context.galleryUrls.some((url) => !input.record.gallery.some((image) => image.url === url))
  ) {
    throw new Error("variant_method_or_gallery_not_archived");
  }
  const wrongBinding = input.review.imageAssignments.some(
    (image) =>
      context.galleryUrls.includes(image.url) &&
      image.variantId !== null &&
      image.variantId !== context.variantId,
  );
  if (wrongBinding) {
    throw new Error("variant_gallery_binding_conflict");
  }
}
