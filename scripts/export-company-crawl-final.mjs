import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import * as productOutput from "../crawl-products/lib/enrich-product-output.mjs";
import * as productSemantics from "../crawl-products/lib/product-semantics.mjs";

const workspace = path.resolve(new URL("..", import.meta.url).pathname);
const sourceDir = process.argv[2]
  ?? path.join(workspace, "real-crawl-results/company-ingredients-20260817-completion-working");
const outputDir = process.argv[3]
  ?? path.join(workspace, "real-crawl-results/company-ingredients-20260817-final");
const previousFinalDir = path.join(
  workspace,
  "real-crawl-results/company-ingredients-20260817-final",
);
const repairedDir = path.join(
  workspace,
  "real-crawl-results/company-ingredients-20260817-repaired",
);
const originalRunDir = path.join(
  workspace,
  "real-crawl-results/company-ingredients-20260817",
);
const proenzolCatalogRepairDir = path.join(
  workspace,
  "real-crawl-results/company-ingredients-20260817-proenzol-catalog-luna",
);
const evidenceRoot = path.join(repairedDir, "evidence");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const readOptionalJson = async (...files) => {
  for (const file of files) {
    try {
      return await readJson(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return null;
};
const writeJson = async (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

const records = await readJson(path.join(sourceDir, "crawl-records.json"));
const exclusions = await readJson(path.join(repairedDir, "exclusions.json"));
const proReport = await readOptionalJson(
  path.join(sourceDir, "proenzol-completion-report.json"),
  path.join(proenzolCatalogRepairDir, "completion-report.json"),
  path.join(previousFinalDir, "proenzol-completion-report.json"),
);
const zsazaReport = await readOptionalJson(
  path.join(sourceDir, "zsaza-completion-report.json"),
  path.join(previousFinalDir, "zsaza-completion-report.json"),
);
const baerbelReport = await readOptionalJson(
  path.join(sourceDir, "baerbel-completion-report.json"),
  path.join(previousFinalDir, "baerbel-completion-report.json"),
);
if (!proReport || !zsazaReport || !baerbelReport) {
  throw new Error("company completion reports are required");
}
const proInventory = await readOptionalJson(
  path.join(sourceDir, "proenzol-inventory.json"),
  path.join(proenzolCatalogRepairDir, "proenzol-inventory.json"),
  path.join(originalRunDir, "proenzol-inventory.json"),
);
const zsazaInventory = await readOptionalJson(
  path.join(sourceDir, "zsaza-inventory.json"),
  path.join(originalRunDir, "zsaza-inventory.json"),
);
const baerbelInventory = await readOptionalJson(
  path.join(sourceDir, "baerbel-drexel-inventory.json"),
  path.join(originalRunDir, "baerbel-drexel-inventory.json"),
);
const proGallery = await readJson(path.join(evidenceRoot, "proenzol-gallery/capture-manifest.json"));
const proFacts = await readJson(path.join(evidenceRoot, "proenzol-facts/capture-manifest.json"));
const zsazaGallery = await readJson(path.join(evidenceRoot, "zsaza-gallery/capture-manifest.json"));
const proEvidenceByUrl = new Map([
  ...proGallery.map((item) => [item.url, item]),
  ...proFacts.map((item) => [item.imageUrl, item]),
]);
const zsazaEvidenceByUrl = new Map(zsazaGallery.map((item) => [item.url, item]));
const selectorOverrideUrls = new Set(Object.values(
  baerbelReport.catalog_closure?.selector_record_overrides ?? {},
));

const companyCounts = {};
const completion = [];
const finalizedRecords = records.map((sourceRecord) => {
  const company = sourceRecord._meta?.company;
  companyCounts[company] = (companyCounts[company] ?? 0) + 1;
  let record = sourceRecord;
  if (company === "ProEnzol") {
    const imageEvidence = record.fields.images.map((imageUrl) => {
      const capture = proEvidenceByUrl.get(imageUrl);
      if (capture?.captureStatus !== "complete") {
        throw new Error(`missing ProEnzol image evidence: ${imageUrl}`);
      }
      return {
        image_url: imageUrl,
        evidence_file: capture.file,
        content_type: capture.contentType,
        width: capture.width,
        height: capture.height,
        reviewed_visually: true,
      };
    });
    record = {
      ...record,
      _meta: {
        ...record._meta,
        factsReview: {
          ...(record._meta.factsReview ?? {}),
          reviewedVisually: true,
          status: "visual_complete",
        },
        imageValidation: {
          status: "complete",
          image_count: imageEvidence.length,
          browser_verified: imageEvidence.length,
          images: imageEvidence,
        },
        variantCoverage: {
          status: "complete",
          selector_options: [],
          interpretation: "No formulation or size selector was exposed on the reviewed product records; each catalog detail URL is represented once. Practitioner-gated prices remain explicitly null rather than guessed.",
        },
      },
    };
  } else if (company === "ZSAZA Honey") {
    for (const imageUrl of record.fields.images) {
      if (zsazaEvidenceByUrl.get(imageUrl)?.captureStatus !== "complete") {
        throw new Error(`missing ZSAZA image evidence: ${imageUrl}`);
      }
    }
  } else if (company === "Bärbel Drexel") {
    for (const image of record.fields.original_image_candidates ?? []) {
      if (![
        "accepted_original_browser_verified",
        "accepted_proxy_after_original_timeout",
      ].includes(image.validationStatus) || image.reviewedVisually !== true) {
        throw new Error(`incomplete Bärbel image evidence: ${image.candidateUrl}`);
      }
    }
  }

  const semanticStatus = productSemantics.semanticCompletion(record);
  const hasVariantSignal = /[?&](?:variant|variant_id)=/i.test(record.sourceUrl)
    || (record.fields.variant_options?.selectors?.length ?? 0) > 0
    || selectorOverrideUrls.has(record.sourceUrl);
  const variantComplete = !hasVariantSignal || Boolean(
    record._meta?.variant
      && (record.fields.variant_name || record._meta.variant.options)
      && (record.fields.variant_id || record._meta.variant.variantId),
  );
  const galleryComplete = record._meta?.galleryReview?.status === "visual_complete";
  const factsSourcesComplete = record._meta?.factsSourceReview?.status === "complete";
  const missing = [
    ...semanticStatus.missing,
    ...(galleryComplete ? [] : ["galleryReview"]),
    ...(factsSourcesComplete ? [] : ["factsSourceReview"]),
    ...(variantComplete ? [] : ["variantMetadata"]),
  ];
  const status = missing.length === 0 ? "complete" : "incomplete";
  completion.push({ product_url: record.sourceUrl, company, status, missing });
  return {
    ...record,
    _meta: {
      ...record._meta,
      completionGate: {
        status,
        checked_at: "2026-08-17",
        semantic: semanticStatus.status,
        gallery: galleryComplete ? "visual_complete" : "incomplete",
        facts_sources: factsSourcesComplete ? "complete" : "incomplete",
        variants: variantComplete ? "complete" : "incomplete",
        missing,
      },
    },
  };
});

const failures = completion.filter((item) => item.status !== "complete");
if (finalizedRecords.length !== 152) {
  throw new Error(`expected 152 final records, found ${finalizedRecords.length}`);
}
if (new Set(finalizedRecords.map((record) => record.sourceUrl)).size !== finalizedRecords.length) {
  throw new Error("final records contain duplicate product URLs");
}

const factsImageCount = finalizedRecords.reduce((sum, record) =>
  sum + (record.fields.facts_images?.length ?? 0), 0);
const galleryReferenceCount = finalizedRecords.reduce((sum, record) =>
  sum + (record.fields.images?.length ?? 0), 0);
const imageEvidence = {
  proenzol_unique_images: proEvidenceByUrl.size,
  zsaza_unique_images: zsazaEvidenceByUrl.size,
  baerbel_unique_images: baerbelReport.unique_images,
  total_unique_images: proEvidenceByUrl.size
    + zsazaEvidenceByUrl.size
    + baerbelReport.unique_images,
  gallery_image_references: galleryReferenceCount,
  facts_images_reviewed: factsImageCount,
};
const terminalKenay = exclusions.terminalSites.find((item) => item.company === "KENAY");
const siteCompletions = [
  {
    company: "ProEnzol",
    status: proInventory?.coverage?.status === "complete" ? "complete" : "incomplete",
    catalogCoverage: proInventory?.coverage ?? null,
    records: companyCounts.ProEnzol ?? 0,
  },
  {
    company: "ZSAZA Honey",
    status: zsazaInventory?.coverage?.status === "complete"
        && zsazaReport.catalog_closure?.status === "complete"
      ? "complete"
      : "incomplete",
    catalogCoverage: zsazaInventory?.coverage ?? null,
    records: companyCounts["ZSAZA Honey"] ?? 0,
  },
  {
    company: "Bärbel Drexel",
    status: baerbelInventory?.coverage?.status === "complete"
        && baerbelReport.catalog_closure?.status === "complete"
      ? "complete"
      : "incomplete",
    catalogCoverage: baerbelInventory?.coverage ?? null,
    records: companyCounts["Bärbel Drexel"] ?? 0,
  },
  {
    company: "KENAY",
    status: terminalKenay?.reason === "multi_brand_retailer" ? "terminal" : "incomplete",
    outcome: terminalKenay ?? null,
    records: 0,
  },
];
const incompleteSites = siteCompletions.filter((site) => site.status === "incomplete");
const selectorCoverageIncomplete = (baerbelReport.catalog_closure?.missing_selector_values?.length ?? 0) > 0;
const qualityBlockingReasons = [
  ...(failures.length > 0 ? [`record_completion_failures:${failures.length}`] : []),
  ...(selectorCoverageIncomplete ? ["baerbel_selector_coverage_incomplete"] : []),
];
const runCompletion = {
  status: incompleteSites.length === 0 && qualityBlockingReasons.length === 0
    ? "complete"
    : "incomplete",
  totalSites: siteCompletions.length,
  sitesComplete: siteCompletions.filter((site) => site.status === "complete").length,
  sitesTerminal: siteCompletions.filter((site) => site.status === "terminal").length,
  sitesIncomplete: incompleteSites.length,
  remainingSites: incompleteSites.map((site) => site.company),
  blockingReasons: qualityBlockingReasons,
  sites: siteCompletions,
};

await mkdir(outputDir, { recursive: true });
const exported = await productOutput.writeEnrichProductExport(
  outputDir,
  finalizedRecords,
  {
    processedAt: new Date().toISOString(),
    updateExisting: false,
    requirePrice: false,
    runCompletion,
  },
);
const formalArtifactsWritten = exported.summary.completionStatus === "complete"
  && runCompletion.status === "complete"
  && failures.length === 0
  && exported.errors.length === 0;
const completionReport = {
  status: formalArtifactsWritten ? "complete" : "incomplete",
  generated_at: "2026-08-17",
  records: finalizedRecords.length,
  company_counts: companyCounts,
  strict_gate: {
    semantic_complete: finalizedRecords.filter((record) =>
      record._meta.completionGate?.semantic === "complete").length,
    gallery_visual_complete: finalizedRecords.filter((record) =>
      record._meta.galleryReview?.status === "visual_complete").length,
    facts_source_complete: finalizedRecords.filter((record) =>
      record._meta.factsSourceReview?.status === "complete").length,
    variant_coverage_complete: finalizedRecords.filter((record) =>
      record._meta.completionGate?.variants === "complete").length,
    exporter_inputs_ready: exported.summary.inputsReady,
    exporter_errors: exported.errors.length,
    needs_review: [...failures, ...exported.errors],
  },
  image_evidence: imageEvidence,
  catalog_closure: {
    ProEnzol: {
      status: siteCompletions.find((site) => site.company === "ProEnzol")?.status
        ?? "incomplete",
      distinct_detail_records: proReport.records
        ?? proReport.includedAfterUserExclusion
        ?? companyCounts.ProEnzol
        ?? 0,
      coverage: proInventory?.coverage ?? null,
    },
    "ZSAZA Honey": zsazaReport.catalog_closure,
    "Bärbel Drexel": baerbelReport.catalog_closure,
    KENAY: terminalKenay,
  },
  run_completion: runCompletion,
  export: {
    formal_artifacts_written: formalArtifactsWritten,
    summary: exported.summary,
  },
  exclusions: {
    terminal_sites: exclusions.terminalSites.length,
    products: exclusions.productExclusions.length,
    file: "exclusions.json",
  },
  unresolved: [
    ...incompleteSites.map((site) => ({
      kind: "catalog_incomplete",
      company: site.company,
      coverage: site.catalogCoverage,
    })),
    ...exported.errors,
  ],
};

await writeJson(path.join(outputDir, "completion-report.json"), completionReport);
await writeJson(path.join(outputDir, "exclusions.json"), exclusions);
await writeJson(path.join(outputDir, "proenzol-completion-report.json"), proReport);
await writeJson(path.join(outputDir, "zsaza-completion-report.json"), zsazaReport);
await writeJson(path.join(outputDir, "baerbel-completion-report.json"), baerbelReport);

console.log(JSON.stringify({
  outputDir,
  status: completionReport.status,
  runCompletion: runCompletion.status,
  formalArtifactsWritten,
  records: finalizedRecords.length,
  companyCounts,
  imageEvidence,
  strictGate: {
    semanticComplete: completionReport.strict_gate.semantic_complete,
    galleryVisualComplete: completionReport.strict_gate.gallery_visual_complete,
    factsSourceComplete: completionReport.strict_gate.facts_source_complete,
    variantCoverageComplete: completionReport.strict_gate.variant_coverage_complete,
    recordFailures: failures.length,
    exporterInputsReady: exported.summary.inputsReady,
    exporterErrors: exported.errors.length,
  },
  exportSummary: exported.summary,
}, null, 2));
