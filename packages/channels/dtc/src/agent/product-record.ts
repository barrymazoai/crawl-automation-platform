import { z } from "zod";
import { parseCaptureReview, type CaptureReview } from "./product-review.js";
import { captureFile, type CaptureFile } from "./archive.js";
import { dtcAgentErrors } from "./errors.js";
import { verifyObservedProduct } from "../../../../../crawl-products/lib/observed-product.mjs";
import { verifyDetailReview } from "./detail-review.js";

const VariantSchema = z
  .object({
    variantId: z.union([z.string(), z.number()]).transform(String).optional(),
    sku: z.string().optional(),
    title: z.string().optional(),
    url: z.url().optional(),
  })
  .passthrough();
const RecordSchema = z
  .object({
    productUrl: z.url(),
    fields: z.record(z.string(), z.unknown()),
    gallery: z
      .array(z.object({ url: z.url(), localPath: z.string().min(1), mime: z.string().min(1) }))
      .min(1)
      .max(100),
    variants: z.array(VariantSchema).default([]),
    pageHtml: z.union([z.string(), z.object({ localPath: z.string() })]),
    flags: z.array(z.string()).default([]),
  })
  .passthrough();
export type HarvestRecord = z.infer<typeof RecordSchema>;
export type { CaptureReview } from "./product-review.js";

export async function readCapturedProduct(input: {
  root: string;
  files: CaptureFile[];
  evidenceFiles?: CaptureFile[];
  url: string;
  requireObservedMethod?: boolean;
  requireDetailCoverage?: boolean;
}) {
  const { record, review } = await readRecordAndReview(input.root, input.url);
  verifyGallery(record, review, {
    files: input.files,
    evidenceFiles: input.evidenceFiles ?? input.files,
  });
  verifyVariant(record, review, input.url);
  if (input.requireObservedMethod) {
    await verifyMethod(input, record);
  }
  await verifyDetailReview({
    root: input.root,
    record,
    review,
    files: input.files,
    required: input.requireDetailCoverage,
  });
  const htmlPath =
    typeof record.pageHtml === "string" ? record.pageHtml : record.pageHtml.localPath;
  const html = await captureFile(input.root, htmlPath);
  return {
    record,
    review,
    html,
    images: record.gallery.map((image) => ({
      ...input.files.find((file) => file.path === image.localPath),
      url: image.url,
      mediaType: image.mime,
    })),
  };
}

async function readRecordAndReview(root: string, url: string) {
  const records = z
    .array(RecordSchema)
    .length(1)
    .parse(JSON.parse((await captureFile(root, "evidence/records.json")).toString()));
  const record = records[0];
  const review = parseCaptureReview(
    JSON.parse((await captureFile(root, "capture-review.json")).toString()),
  );
  if (!record || !sameProduct(record.productUrl, url) || !sameProduct(review.productUrl, url)) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
  }
  return { record, review };
}

export async function verifyMethod(
  input: { root: string; files: CaptureFile[] },
  record: HarvestRecord,
) {
  try {
    const sources = await verifyObservedProduct(input.root, record);
    if (
      sources.some(
        (source) =>
          !input.files.some((file) => file.path === source.path && file.sha256 === source.sha256),
      )
    ) {
      throw new Error("observed_source_not_archived");
    }
  } catch (cause) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE", {
      details: { reason: "observed_method_unverified", message: String(cause) },
    });
  }
}

function verifyVariant(record: HarvestRecord, review: CaptureReview, url: string) {
  const selected =
    new URL(url).searchParams.get("variant") ?? new URL(url).searchParams.get("variation_id");
  if (
    (selected && selected !== review.selectedVariantId) ||
    (review.selectedVariantId &&
      !record.variants.some((variant) => variant.variantId === review.selectedVariantId))
  ) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
  }
}

function verifyGallery(
  record: HarvestRecord,
  review: CaptureReview,
  retained: { files: CaptureFile[]; evidenceFiles: CaptureFile[] },
) {
  const urls = new Set(record.gallery.map((image) => image.url));
  const known = new Set(retained.files.map((file) => file.path));
  const proof = new Set(retained.evidenceFiles.map((file) => file.path));
  const assigned = new Set(review.imageAssignments.map((image) => image.url));
  if (
    urls.size !== record.gallery.length ||
    new Set(review.galleryUrls).size !== urls.size ||
    review.galleryUrls.some((url) => !urls.has(url)) ||
    assigned.size !== urls.size ||
    review.imageAssignments.length !== urls.size ||
    [...assigned].some((url) => !urls.has(url)) ||
    record.gallery.some((image) => !known.has(image.localPath)) ||
    review.evidence.some((path) => !proof.has(path))
  ) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
  }
  if (record.flags.some((flag) => /image_download_failed|page_html_failed/.test(flag))) {
    throw dtcAgentErrors.create("DTC.CAPTURE_REVIEW", { details: { flags: record.flags } });
  }
}

function sameProduct(actual: string, expected: string) {
  const left = new URL(actual);
  const right = new URL(expected);
  return (
    left.origin === right.origin &&
    left.pathname.replace(/\/$/, "") === right.pathname.replace(/\/$/, "")
  );
}
