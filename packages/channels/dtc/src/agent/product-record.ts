import { z } from "zod";
import { captureFile, type CaptureFile } from "./archive.js";
import { dtcAgentErrors } from "./errors.js";

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
const ReviewSchema = z.object({
  productUrl: z.url(),
  selectedVariantId: z.string().nullable(),
  galleryUrls: z.array(z.url()).min(1),
  galleryComplete: z.literal(true),
  variantsComplete: z.literal(true),
  detailComplete: z.literal(true),
  method: z.string().min(1),
  surface: z.literal("local_file"),
  verifier: z.literal("codex"),
  evidence: z.array(z.string()).min(1),
  imageAssignments: z
    .array(
      z.object({
        url: z.url(),
        variantId: z.string().nullable(),
        basis: z.enum(["product-gallery", "variant-featured"]),
      }),
    )
    .min(1),
});
export type HarvestRecord = z.infer<typeof RecordSchema>;
export type CaptureReview = z.infer<typeof ReviewSchema>;

export async function readCapturedProduct(input: {
  root: string;
  files: CaptureFile[];
  evidenceFiles?: CaptureFile[];
  url: string;
}) {
  const records = z
    .array(RecordSchema)
    .length(1)
    .parse(JSON.parse((await captureFile(input.root, "evidence/records.json")).toString()));
  const record = records[0];
  const review = ReviewSchema.parse(
    JSON.parse((await captureFile(input.root, "capture-review.json")).toString()),
  );
  if (
    !record ||
    !sameProduct(record.productUrl, input.url) ||
    !sameProduct(review.productUrl, input.url)
  ) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
  }
  verifyGallery(record, review, {
    files: input.files,
    evidenceFiles: input.evidenceFiles ?? input.files,
  });
  verifyVariant(record, review, input.url);
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
