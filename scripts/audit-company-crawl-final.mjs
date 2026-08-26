import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildEnrichProductExport } from "../crawl-products/lib/enrich-product-output.mjs";

const targetDir = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("usage: node scripts/audit-company-crawl-final.mjs <final-output-dir>");
}

const readJson = async (name, { optional = false } = {}) => {
  try {
    return JSON.parse(await readFile(path.join(targetDir, name), "utf8"));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
};

const records = await readJson("crawl-records.json");
const completion = await readJson("completion-report.json");
const products = await readJson("products.json", { optional: true });
const exportReport = await readJson("enrich-export-report.json", { optional: true });
const writtenErrors = await readJson("product-enrich-errors.json", { optional: true });
const issues = [];

if (!Array.isArray(records) || records.length === 0) issues.push("crawl_records_empty");
if (completion.status !== "complete") issues.push("completion_report_not_complete");
if (completion.run_completion?.status !== "complete") issues.push("run_completion_not_complete");
if (completion.export?.formal_artifacts_written !== true) issues.push("formal_artifacts_not_written");
if (!Array.isArray(products)) {
  issues.push("products_json_missing");
} else {
  const invalidEnvelopes = products.filter((item) =>
    !item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).length !== 1 || !item.json);
  if (invalidEnvelopes.length > 0) {
    issues.push(`invalid_product_envelopes:${invalidEnvelopes.length}`);
  }
}
if (!exportReport) issues.push("enrich_export_report_missing");
if (!Array.isArray(writtenErrors)) issues.push("product_enrich_errors_missing");
else if (writtenErrors.length > 0) issues.push(`written_export_errors:${writtenErrors.length}`);

const urls = records.map((record) => record.sourceUrl).filter(Boolean);
if (new Set(urls).size !== records.length) issues.push("duplicate_or_missing_product_urls");

const selectorOverrideUrls = new Set(Object.values(
  completion.catalog_closure?.["Bärbel Drexel"]?.selector_record_overrides ?? {},
));
let variantGaps = 0;
let galleryGaps = 0;
let factsReviewGaps = 0;
let whitespaceImageUrls = 0;
let ingredientEvidenceGaps = 0;
let factsVisibleTextGaps = 0;
const searchableText = (value) => {
  const values = [];
  const visit = (item) => {
    if (typeof item === "string") values.push(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(value);
  return values.join(" ").replace(/\s+/g, " ").toLocaleLowerCase();
};
for (const record of records) {
  const fields = record.fields ?? {};
  const hasVariantSignal = /[?&](?:variant|variant_id)=/i.test(record.sourceUrl ?? "")
    || (fields.variant_options?.selectors?.length ?? 0) > 0
    || selectorOverrideUrls.has(record.sourceUrl);
  if (hasVariantSignal && !(
    record._meta?.variant
      && (fields.variant_name || record._meta.variant.options)
      && (fields.variant_id || record._meta.variant.variantId)
  )) variantGaps += 1;

  const reviewedImages = new Set(
    record._meta?.galleryReview?.reviewed_image_urls
      ?? fields.gallery_review?.reviewed_image_urls
      ?? [],
  );
  if (record._meta?.galleryReview?.status !== "visual_complete"
      || (fields.images ?? []).some((url) => !reviewedImages.has(url))) {
    galleryGaps += 1;
  }
  whitespaceImageUrls += (fields.images ?? []).filter((url) => /\s/.test(url)).length;

  const factsReviews = new Map((record._meta?.factsIngredientReviews ?? []).map((review) => [
    review.image_url,
    review,
  ]));
  if ((fields.facts_images ?? []).some((image) => {
    const url = typeof image === "string" ? image : image.image_url ?? image.imageUrl ?? image.url;
    return factsReviews.get(url)?.status !== "visual_complete";
  })) factsReviewGaps += 1;

  if (record._meta?.company === "Bärbel Drexel") {
    const recordCorpus = searchableText({
      ingredients: fields.ingredients,
      ingredientsRaw: fields.ingredients_raw,
      supplementFacts: fields.supplement_facts ?? fields.supplementFacts,
      description: fields.description,
      factsImageReviews: record._meta?.factsIngredientReviews,
    });
    for (const inference of record._meta?.semanticInferences?.main_ingredients ?? []) {
      const evidence = inference?.evidence?.[0];
      const sourceTerm = String(evidence?.sourceTerm ?? "").trim();
      const excerpt = String(evidence?.excerpt ?? "").replace(/\s+/g, " ").trim();
      const normalizedTerm = sourceTerm.toLocaleLowerCase();
      if (!sourceTerm
          || !excerpt.toLocaleLowerCase().includes(normalizedTerm)
          || !recordCorpus.includes(normalizedTerm)) {
        ingredientEvidenceGaps += 1;
      }
    }
    for (const review of record._meta?.factsIngredientReviews ?? []) {
      const visibleCorpus = searchableText(review.evidence?.visibleText);
      for (const ingredient of review.ingredients ?? []) {
        const visibleText = String(ingredient?.visibleText ?? "").trim();
        if (!visibleText || !visibleCorpus.includes(visibleText.toLocaleLowerCase())) {
          factsVisibleTextGaps += 1;
        }
      }
    }
  }
}
if (variantGaps > 0) issues.push(`variant_metadata_gaps:${variantGaps}`);
if (galleryGaps > 0) issues.push(`gallery_review_gaps:${galleryGaps}`);
if (factsReviewGaps > 0) issues.push(`facts_ingredient_review_gaps:${factsReviewGaps}`);
if (whitespaceImageUrls > 0) issues.push(`image_urls_with_whitespace:${whitespaceImageUrls}`);
if (ingredientEvidenceGaps > 0) issues.push(`ingredient_evidence_locality_gaps:${ingredientEvidenceGaps}`);
if (factsVisibleTextGaps > 0) issues.push(`facts_visible_text_gaps:${factsVisibleTextGaps}`);

const rebuilt = buildEnrichProductExport(records, {
  processedAt: new Date().toISOString(),
  updateExisting: false,
  requirePrice: false,
});
if (rebuilt.errors.length > 0) issues.push(`strict_export_errors:${rebuilt.errors.length}`);
if (rebuilt.inputs.length === 0) issues.push("strict_export_has_no_inputs");

const summary = {
  targetDir,
  status: issues.length === 0 ? "pass" : "fail",
  records: records.length,
  uniqueProductUrls: new Set(urls).size,
  formalProducts: Array.isArray(products) ? products.length : 0,
  strictInputsReady: rebuilt.inputs.length,
  strictErrors: rebuilt.errors.length,
  variantGaps,
  galleryGaps,
  factsReviewGaps,
  whitespaceImageUrls,
  ingredientEvidenceGaps,
  factsVisibleTextGaps,
  issues,
};
console.log(JSON.stringify(summary, null, 2));
if (issues.length > 0) process.exitCode = 1;
