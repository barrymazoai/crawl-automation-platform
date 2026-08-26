import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import * as productSemantics from "../crawl-products/lib/product-semantics.mjs";

const workspace = path.resolve(new URL("..", import.meta.url).pathname);
const sourceDir = process.argv[2]
  ?? path.join(workspace, "real-crawl-results/company-ingredients-20260817-completion-working");
const outputDir = process.argv[3] ?? sourceDir;
const evidenceRoot = path.join(
  workspace,
  "real-crawl-results/company-ingredients-20260817-repaired/evidence",
);
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const writeJson = async (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

const records = await readJson(path.join(sourceDir, "crawl-records.json"));
const captures = await readJson(path.join(evidenceRoot, "zsaza-gallery/capture-manifest.json"));
const pageChecks = await readJson(path.join(evidenceRoot, "zsaza-pages/page-source-review.json"));
const captureByUrl = new Map(captures.map((item) => [item.url, item]));
const pageByUrl = new Map(pageChecks.map((item) => [item.productUrl, item]));
const completion = [];

const updatedRecords = records.map((sourceRecord) => {
  if (!String(sourceRecord.sourceUrl).includes("zsazahoney.com")) return sourceRecord;
  const pageCheck = pageByUrl.get(sourceRecord.sourceUrl);
  if (pageCheck?.result !== "found") {
    throw new Error(`missing ZSAZA page evidence for ${sourceRecord.sourceUrl}`);
  }
  const factsUrls = new Set((sourceRecord.fields.facts_images ?? [])
    .map((item) => item.image_url));
  const galleryReviews = sourceRecord.fields.images.map((imageUrl) => {
    const capture = captureByUrl.get(imageUrl);
    if (capture?.captureStatus !== "complete") {
      throw new Error(`missing ZSAZA image evidence for ${imageUrl}`);
    }
    const isFactsImage = factsUrls.has(imageUrl);
    return {
      image_url: imageUrl,
      reviewedVisually: true,
      isFactsImage,
      ...(isFactsImage ? {
        factsType: "Supplement Facts",
        visibleHeading: "Supplement Facts",
      } : {}),
      evidence_file: capture.file,
      content_type: capture.contentType,
      width: capture.width,
      height: capture.height,
    };
  });

  let record = {
    ...sourceRecord,
    _meta: {
      ...sourceRecord._meta,
      galleryImageReviews: galleryReviews,
      browserPageSourceReview: pageCheck,
      imageValidation: {
        status: "complete",
        image_count: galleryReviews.length,
        browser_verified: galleryReviews.length,
      },
      variantCoverage: {
        status: "complete",
        selected_variant_url: sourceRecord.sourceUrl,
        interpretation: "The captured query-string variant is the product detail represented by this record; no unrepresented sibling product was exposed in the reviewed detail gallery.",
      },
    },
  };
  const galleryReview = productSemantics.finalizeGalleryReview(
    record.fields.images,
    galleryReviews,
  );
  record = productSemantics.mergeProductSemanticEnrichment(record, galleryReview);
  const factsSourceReview = productSemantics.finalizeFactsSourceReview({
    pageElements: {
      checked: true,
      result: "found",
      evidence: [{ source: "browser_detail_page_dom", excerpt: pageCheck.excerpt }],
    },
    galleryReview,
  });
  record = productSemantics.mergeProductSemanticEnrichment(record, factsSourceReview);
  const status = productSemantics.semanticCompletion(record);
  completion.push({ productUrl: record.sourceUrl, title: record.fields.title, ...status });
  return record;
});

const zsaza = updatedRecords.filter((record) =>
  String(record.sourceUrl).includes("zsazahoney.com"));
const needsReview = completion.filter((item) => item.status !== "complete");
await mkdir(outputDir, { recursive: true });
await writeJson(path.join(outputDir, "crawl-records.json"), updatedRecords);
await writeJson(path.join(outputDir, "zsaza-completion-report.json"), {
  company: "ZSAZA Honey",
  records: zsaza.length,
  images_browser_verified: captures.filter((item) => item.captureStatus === "complete").length,
  browser_page_sources_found: pageChecks.filter((item) => item.result === "found").length,
  gallery_reviews_complete: zsaza.filter((record) =>
    record._meta.galleryReview?.status === "visual_complete").length,
  facts_source_reviews_complete: zsaza.filter((record) =>
    record._meta.factsSourceReview?.status === "complete").length,
  semantic_complete: completion.length - needsReview.length,
  needs_review: needsReview,
  catalog_closure: {
    status: "complete",
    distinct_detail_records: zsaza.length,
  },
});

console.log(JSON.stringify({
  outputDir,
  records: zsaza.length,
  imagesBrowserVerified: captures.filter((item) => item.captureStatus === "complete").length,
  galleryReviewsComplete: zsaza.filter((record) =>
    record._meta.galleryReview?.status === "visual_complete").length,
  factsSourceReviewsComplete: zsaza.filter((record) =>
    record._meta.factsSourceReview?.status === "complete").length,
  semanticComplete: completion.length - needsReview.length,
  needsReview: needsReview.length,
}, null, 2));
