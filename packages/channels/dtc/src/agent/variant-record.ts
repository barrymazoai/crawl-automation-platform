import { isDeepStrictEqual } from "node:util";
import {
  readObservedProduct,
  readObservedField,
} from "../../../../../crawl-products/lib/observed-product.mjs";
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
  const observed = await readObservedProduct(input.root, sourceMethod);
  await verifySharedScope(input.root, sourceMethod, context);
  verifyIdentity(input, { context, observed, variantId });
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

async function verifySharedScope(root: string, method: unknown, context: ObservedVariantContext) {
  if (context.basis === "website-shared") {
    const statement = await readObservedField(root, method, context.sharedScope.rule);
    if (typeof statement !== "string" || statement !== context.sharedScope.text) {
      throw new Error("variant_shared_scope_statement_mismatch");
    }
  }
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
  if (context.evidence.some((path) => !proof.some((file) => file.path === path))) {
    throw new Error("variant_evidence_not_archived");
  }
  return context;
}

function verifyIdentity(
  input: VariantRecordInput,
  parts: {
    context: ObservedVariantContext;
    observed: Awaited<ReturnType<typeof readObservedProduct>>;
    variantId: string;
  },
) {
  const { context, observed, variantId } = parts;
  const source = new URL(observed.sourceUrl),
    base = new URL(input.record.productUrl);
  const selected = source.searchParams.get("variant") ?? source.searchParams.get("variation_id");
  if (
    source.origin !== base.origin ||
    source.pathname !== base.pathname ||
    (context.basis === "variant-state" && selected !== variantId) ||
    (selected !== null && selected !== variantId) ||
    !isDeepStrictEqual(observed.variants, input.record.variants)
  ) {
    throw new Error("variant_source_identity_or_inventory_changed");
  }
  verifyGallery(input, context);
}

function verifyGallery(input: VariantRecordInput, context: ObservedVariantContext) {
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
