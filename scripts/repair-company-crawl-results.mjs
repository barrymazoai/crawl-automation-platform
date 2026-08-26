#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeEnrichProductExport } from "../crawl-products/lib/enrich-product-output.mjs";
import {
  buildSemanticEvidenceBrief,
  finalizeFactsIngredientReview,
  mergeProductSemanticEnrichment,
  normalizeProductSemanticEnrichment,
} from "../crawl-products/lib/product-semantics.mjs";

const sourceDir = path.resolve(
  process.argv[2]
    ?? "real-crawl-results/company-ingredients-20260817",
);
const outputDir = path.resolve(
  process.argv[3]
    ?? "real-crawl-results/company-ingredients-20260817-repaired",
);

const TRACKING_QUERY_RE = /^(?:categorycode|qid|queryid|utm_|fbclid|gclid|currency|lang)$/i;
const B_GENERIC_PACKAGING_ASSET =
  "https://eu-central-1-visionhc.graphassets.com/AumD7l1ALSjqHWl6oOJN2z/18273v1zTcuMjKiGPJu3";

const KNOWN_SCOPE_EXCLUSIONS = new Map([
  ["https://www.baerbel-drexel.de/silicea-nagelpflege", {
    reason: "non_nutrition_product",
    evidence: "The live description identifies the product as a Kosmetikum.",
  }],
  ["https://www.baerbel-drexel.de/ur-kristallsalz-fein", {
    reason: "non_nutrition_product",
    evidence: "The product is culinary crystal salt, not a nutrition supplement.",
  }],
  ["https://www.baerbel-drexel.de/ur-kristallsalz-granulat", {
    reason: "non_nutrition_product",
    evidence: "The product is culinary crystal salt, not a nutrition supplement.",
  }],
  ["https://proenzol.com/product/canine-digestenz", {
    reason: "non_nutrition_product",
    evidence: "The product category is VETERINARY and the product is intended for dogs.",
  }],
]);

const ZSAZA_FACTS = new Map([
  ["Everyday Vitamin C+", {
    facts: [
      "Supplement Facts (label image; visually verified)",
      "Serving Size: children 1–3 years, 1/2 tsp (3.5 g); adults and children 4+, 1 tsp (7 g)",
      "Servings Per Container: 64; 32",
      "Calories: 10; 20",
      "Total Carbohydrates: 3 g (DV not established); 6 g (2% DV)",
      "Total Sugars: 2 g (DV not established); 4 g (DV not established)",
      "Includes Added Sugars (honey): 2 g (DV not established); 4 g (8% DV)",
      "Vitamin C (as liposomal ascorbic acid [VitaSomal C®]): 75 mg (500% DV); 150 mg (167% DV)",
    ].join("\n"),
    imagePattern: /EverydayVitaminC-supplementfacts/i,
    domConflict: {
      field: "Vitamin C",
      domValue: "150 mcg (167%)",
      labelValue: "150 mg (167%)",
      resolution: "label_image_preferred",
    },
    form: "liquid",
    formEvidence: "Serving Size: 1 tsp (7 g)",
    healthFunctions: [
      { value: "Immune Support", excerpt: "Immune support" },
      { value: "Antioxidant", excerpt: "Antioxidant shield" },
      { value: "Skin Health", excerpt: "Glowing skin" },
    ],
    mainIngredients: [{
      name: "Vitamin C (as liposomal ascorbic acid)",
      substance: "Vitamin C",
      form: "Liposomal Ascorbic Acid",
      category: "vitamins",
      visibleText: "Vitamin C (as Liposomal ascorbic acid [VitaSomal C®]) 150 mg",
    }],
  }],
  ["HoneyBerry Immune+", {
    facts: [
      "Supplement Facts (label image; visually verified)",
      "Serving Size: children 1–3 years, 1/2 tsp (3.5 g); adults and children 4+, 1 tsp (7 g)",
      "Servings Per Container: 64; 32",
      "Calories: 10; 20",
      "Total Carbohydrates: 3 g (DV not established); 6 g (2% DV)",
      "Total Sugars: 2 g (DV not established); 4 g (DV not established)",
      "Includes Added Sugars (honey): 2 g (DV not established); 4 g (8% DV)",
      "Vitamin A (as vitamin A acetate): 100 mcg (33% DV); 200 mcg (22% DV)",
      "Vitamin C (as liposomal ascorbic acid [VitaSomal C®]): 50 mg (333% DV); 100 mg (111% DV)",
      "Vitamin D3 (as cholecalciferol from algae [VegD3®]): 10 mcg (67% DV); 20 mcg (100% DV)",
      "Zinc (as zinc bisglycinate chelate): 2.5 mg (83% DV); 5 mg (45% DV)",
      "Selenium (as L-selenomethionine [Selenium SeLECT®]): 15 mcg (75% DV); 30 mcg (55% DV)",
      "Proprietary Immune Blend: 57.5 mg; 115 mg",
      "Blend ingredients: organic A3-FP Plus™ aronia (Aronia melanocarpa) fruit; organic elderberry juice concentrate (Sambucus L.) fruit; organic partially hydrolyzed guar fiber; organic PureMune® beta glucan (Saccharomyces cerevisiae)",
    ].join("\n"),
    imagePattern: /Honeyberry_Immune_.*supplement_facts/i,
    domConflict: {
      field: "Proprietary Immune Blend",
      domValue: "57.5 mg for the displayed 1 tsp serving",
      labelValue: "115 mg for 1 tsp; 57.5 mg for 1/2 tsp",
      resolution: "label_image_preferred",
    },
    form: "liquid",
    formEvidence: "Serving Size: 1 tsp (7 g)",
    healthFunctions: [
      { value: "Immune Support", excerpt: "Multi-pathway Immune support" },
      { value: "Antioxidant", excerpt: "Antioxidant-rich protection" },
    ],
    mainIngredients: [
      {
        name: "Vitamin A (as vitamin A acetate)",
        substance: "Vitamin A",
        form: "Vitamin A Acetate",
        category: "vitamins",
        visibleText: "Vitamin A (as vitamin A acetate) 200 mcg",
      },
      {
        name: "Vitamin C (as liposomal ascorbic acid)",
        substance: "Vitamin C",
        form: "Liposomal Ascorbic Acid",
        category: "vitamins",
        visibleText: "Vitamin C (as Liposomal ascorbic acid [VitaSomal C®]) 100 mg",
      },
      {
        name: "Vitamin D3 (as cholecalciferol from algae)",
        substance: "Vitamin D3",
        form: "Cholecalciferol From Algae",
        category: "vitamins",
        visibleText: "Vitamin D3 (as cholecalciferol from algae [VegD3®]) 20 mcg",
      },
      {
        name: "Zinc (as zinc bisglycinate chelate)",
        substance: "Zinc",
        form: "Zinc Bisglycinate Chelate",
        category: "minerals",
        visibleText: "Zinc (as Zinc Bisglycinate Chelate) 5 mg",
      },
      {
        name: "Selenium (as L-selenomethionine)",
        substance: "Selenium",
        form: "L-Selenomethionine",
        category: "minerals",
        visibleText: "Selenium (as L-selenomethionine [Selenium SeLECT®]) 30 mcg",
      },
      {
        name: "Organic Aronia Fruit",
        substance: "Aronia",
        category: "herbs_botanicals",
        visibleText: "Organic A3-FP Plus™ Aronia (Aronia melanocarpa) (fruit)",
      },
      {
        name: "Organic Elderberry Juice Concentrate",
        substance: "Elderberry",
        form: "Juice Concentrate",
        category: "herbs_botanicals",
        visibleText: "Organic Elderberry Juice Concentrate (Sambucus L.) (fruit)",
      },
      {
        name: "Organic Partially Hydrolyzed Guar Fiber",
        substance: "Guar Fiber",
        form: "Partially Hydrolyzed",
        category: "fibers_carbs",
        visibleText: "Organic Partially Hydrolyzed Guar Fiber",
      },
      {
        name: "Organic PureMune® Beta Glucan",
        substance: "Beta Glucan",
        form: "Saccharomyces Cerevisiae",
        category: "fibers_carbs",
        visibleText: "Organic PureMune® Beta Glucan (Saccharomyces cerevisiae)",
      },
    ],
  }],
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalProductUrl(value) {
  const parsed = new URL(value);
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_QUERY_RE.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  return parsed.toString().replace(/\/$/, "");
}

function imageIdentity(value) {
  try {
    const parsed = new URL(value);
    if (/\/_next\/image$/i.test(parsed.pathname) && parsed.searchParams.get("url")) {
      return decodeURIComponent(parsed.searchParams.get("url"));
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(value ?? "");
  }
}

function unique(values, identity = (value) => value) {
  const seen = new Set();
  const output = [];
  for (const value of values.filter(Boolean)) {
    const key = identity(value);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function addRepair(record, repair) {
  record._meta ??= {};
  record._meta.repairs = [...(record._meta.repairs ?? []), repair];
}

function richerText(left, right) {
  const a = typeof left === "string" ? left.trim() : "";
  const b = typeof right === "string" ? right.trim() : "";
  return b.length > a.length ? right : left;
}

function mergeDuplicate(base, duplicate) {
  const output = clone(base);
  output.fields ??= {};
  for (const field of ["title", "name", "description", "ingredients", "supplement_facts", "supplementFacts"]) {
    output.fields[field] = richerText(output.fields[field], duplicate.fields?.[field]);
  }
  output.fields.images = unique([
    ...(output.fields.images ?? []),
    ...(duplicate.fields?.images ?? []),
  ], imageIdentity);
  output._meta ??= {};
  output._meta.deduplicatedSourceUrls = unique([
    ...(output._meta.deduplicatedSourceUrls ?? []),
    base.sourceUrl,
    duplicate.sourceUrl,
  ]);
  addRepair(output, {
    kind: "canonical_duplicate_merged",
    sourceUrl: duplicate.sourceUrl,
  });
  return output;
}

function extractGermanIngredients(value) {
  const text = String(value ?? "").replace(/\r/g, "");
  const match = text.match(
    /(?:^|\n)\s*Zutaten\s*:?\s*\n+([\s\S]*?)(?=\n\s*(?:Allergene|Nährwertangaben|Empfohlene Tagesdosis|Verzehrempfehlung|Mehr lesen)\b|$)/i,
  );
  return match?.[1]?.trim() ?? "";
}

function directImageCandidate(value) {
  try {
    const parsed = new URL(value);
    if (!/\/_next\/image$/i.test(parsed.pathname)) return null;
    const target = parsed.searchParams.get("url");
    return target ? decodeURIComponent(target) : null;
  } catch {
    return null;
  }
}

function parsePrice(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/(\d+(?:[.,]\d{2})?)/);
  if (!match) return null;
  const amount = Number(match[1].replace(",", "."));
  return Number.isFinite(amount) ? amount : null;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

await mkdir(outputDir, { recursive: true });

const records = await readJson(path.join(sourceDir, "crawl-records.json"));
const priorExclusions = await readJson(path.join(sourceDir, "exclusions.json"));
const proDescriptionRecords = [
  ...await readJson(path.join(outputDir, "proenzol-description-repair-a.json")),
  ...await readJson(path.join(outputDir, "proenzol-description-repair-b.json")),
];
const proDescriptionByUrl = new Map(
  proDescriptionRecords
    .filter((item) => item.ok)
    .map((item) => [canonicalProductUrl(item.url), item]),
);

const canonicalRecords = new Map();
let duplicatesRemoved = 0;
for (const sourceRecord of records) {
  const record = clone(sourceRecord);
  const originalUrl = record.fields?.url ?? record.sourceUrl;
  const canonicalUrl = canonicalProductUrl(originalUrl);
  record.fields.url = canonicalUrl;
  record.sourceUrl = canonicalUrl;
  if (canonicalUrl !== originalUrl) {
    addRepair(record, {
      kind: "tracking_query_removed",
      originalUrl,
      canonicalUrl,
    });
  }
  if (canonicalRecords.has(canonicalUrl)) {
    canonicalRecords.set(
      canonicalUrl,
      mergeDuplicate(canonicalRecords.get(canonicalUrl), record),
    );
    duplicatesRemoved += 1;
  } else {
    canonicalRecords.set(canonicalUrl, record);
  }
}

const scopeExclusions = [];
const repairedRecords = [];
const factsConflicts = [];
let proDescriptionsRepaired = 0;
let baerbelIngredientsSplit = 0;
let directImageCandidatesCreated = 0;
let genericGalleryAssetsClassified = 0;
let pricesNormalized = 0;

for (let record of canonicalRecords.values()) {
  const fields = record.fields ??= {};
  const company = record._meta?.company;
  const scopeExclusion = KNOWN_SCOPE_EXCLUSIONS.get(fields.url);
  if (scopeExclusion) {
    scopeExclusions.push({
      company,
      title: fields.title,
      url: fields.url,
      ...scopeExclusion,
    });
    continue;
  }

  const repairedDescription = proDescriptionByUrl.get(fields.url);
  if (company === "ProEnzol" && repairedDescription?.description) {
    fields.description = repairedDescription.description;
    fields.category = repairedDescription.category || fields.category;
    addRepair(record, {
      kind: "description_selector_repaired",
      evidence: "All product-summary paragraphs were read; account prompts were excluded.",
    });
    proDescriptionsRepaired += 1;
  }

  if (company === "ZSAZA Honey" && ZSAZA_FACTS.has(fields.title)) {
    const correction = ZSAZA_FACTS.get(fields.title);
    const factsImage = (fields.images ?? []).find((image) => correction.imagePattern.test(image));
    fields.supplement_facts_dom = fields.supplement_facts;
    fields.supplement_facts = correction.facts;
    fields.supplementFacts = correction.facts;
    fields.supplement_facts_image = factsImage ?? null;
    fields.facts_images = factsImage ? [{
      image_url: factsImage,
      type: "Supplement Facts",
      reviewedVisually: true,
      visible_heading: "Supplement Facts",
    }] : [];
    record._meta.factsConflict = correction.domConflict;
    record._meta.factsImageReview = {
      status: "visual_complete",
      reviewedVisually: true,
      imageUrl: factsImage ?? null,
    };
    const brief = buildSemanticEvidenceBrief(record);
    record._meta.semanticEvidenceBrief = {
      built: true,
      ingredientsPresent: Boolean(brief.ingredients),
      factsImageCount: brief.factsImages?.length ?? 0,
    };
    const factsIngredientReview = finalizeFactsIngredientReview({
      image_url: factsImage,
      type: "Supplement Facts",
    }, {
      reviewedVisually: true,
      visibleHeading: "Supplement Facts",
      ingredients: correction.mainIngredients,
    });
    record = mergeProductSemanticEnrichment(record, factsIngredientReview);
    const semanticEnrichment = normalizeProductSemanticEnrichment({
      form: {
        value: correction.form,
        basis: "inferred",
        confidence: "high",
        rationale: "The label expresses the serving in teaspoons and grams, and the product is a spoonable honey preparation.",
        evidence: [{ source: "supplement_facts_image", excerpt: correction.formEvidence }],
      },
      healthFunction: correction.healthFunctions.map((item) => ({
        value: item.value,
        basis: "explicit",
        confidence: "high",
        evidence: [{ source: "benefits", excerpt: item.excerpt }],
      })),
    });
    record = mergeProductSemanticEnrichment(record, semanticEnrichment);
    addRepair(record, {
      kind: "facts_dom_image_conflict_resolved",
      resolution: "label_image_preferred",
      conflict: correction.domConflict,
    });
    factsConflicts.push({
      title: fields.title,
      url: fields.url,
      imageUrl: factsImage ?? null,
      ...correction.domConflict,
    });
  }

  if (company === "Bärbel Drexel") {
    const rawIngredients = fields.ingredients;
    const cleanIngredients = extractGermanIngredients(rawIngredients);
    if (cleanIngredients) {
      fields.ingredients_raw = rawIngredients;
      fields.ingredients = cleanIngredients;
      addRepair(record, {
        kind: "ingredients_section_split",
        sourceSection: "#ingredients > Zutaten",
      });
      baerbelIngredientsSplit += 1;
    }

    const candidates = (fields.images ?? [])
      .map((proxyUrl) => ({ proxyUrl, candidateUrl: directImageCandidate(proxyUrl) }))
      .filter((item) => item.candidateUrl);
    if (candidates.length > 0) {
      fields.original_image_candidates = candidates.map((item) => ({
        ...item,
        validationStatus: "pending_browser_mime_and_dimension_check",
      }));
      directImageCandidatesCreated += candidates.length;
    }

    const genericImages = (fields.images ?? []).filter(
      (image) => imageIdentity(image) === B_GENERIC_PACKAGING_ASSET,
    );
    if (genericImages.length > 0) {
      record._meta.imageClassifications = [
        ...(record._meta.imageClassifications ?? []),
        ...genericImages.map((imageUrl) => ({
          imageUrl,
          assetIdentity: B_GENERIC_PACKAGING_ASSET,
          kind: "generic_brand_gallery_asset",
          reviewedVisually: true,
          action: "retained_for_complete_source_gallery",
        })),
      ];
      genericGalleryAssetsClassified += 1;
    }

    if (fields.title === "Jod naturrein Presslinge" && !fields.supplement_facts) {
      record._meta.factsSourceObservation = {
        pageElementStatus: "not_present",
        selectorChecked: "#nutritional_table",
        reviewedLive: true,
        galleryStatus: "pending_visual_review",
      };
    }
  }

  const priceValue = parsePrice(fields.price);
  if (priceValue !== null) {
    fields.price_value = priceValue;
    fields.price_currency = fields.currency ?? null;
    pricesNormalized += 1;
  }

  repairedRecords.push(record);
}

const allProductExclusions = [
  ...(priorExclusions.productExclusions ?? []),
  ...scopeExclusions,
];
const exclusions = {
  terminalSites: priorExclusions.terminalSites ?? [],
  productExclusions: allProductExclusions,
};

const companyCounts = Object.fromEntries(
  Object.entries(Object.groupBy(repairedRecords, (record) => record._meta?.company ?? "unknown"))
    .map(([company, items]) => [company, items.length]),
);
const semanticCompleteCount = repairedRecords.filter((record) =>
  record.fields?.form
  && Array.isArray(record.fields?.health_function)
  && record.fields.health_function.length > 0
  && Array.isArray(record.fields?.main_ingredients)
  && record.fields.main_ingredients.length > 0
).length;
const qualityChecks = {
  uniqueProductUrls:
    new Set(repairedRecords.map((record) => record.fields?.url)).size === repairedRecords.length,
  trackingQueryIdsRemaining: repairedRecords.filter((record) =>
    /[?&](?:qid|queryid)=/i.test(record.fields?.url ?? "")
  ).length,
  knownOutOfScopeRecordsRemaining: repairedRecords.filter((record) =>
    KNOWN_SCOPE_EXCLUSIONS.has(record.fields?.url)
  ).length,
  proenzolDescriptionsUnder200Characters: repairedRecords.filter((record) =>
    record._meta?.company === "ProEnzol"
    && String(record.fields?.description ?? "").length < 200
  ).length,
  baerbelIngredientSectionsOver1500Characters: repairedRecords.filter((record) =>
    record._meta?.company === "Bärbel Drexel"
    && String(record.fields?.ingredients ?? "").length > 1500
  ).length,
  everydayVitaminCUsesMilligrams: repairedRecords.some((record) =>
    record.fields?.title === "Everyday Vitamin C+"
    && /Vitamin C[^\n]*150 mg \(167% DV\)/i.test(record.fields?.supplement_facts ?? "")
  ),
  honeyberryAdultBlendUses115mg: repairedRecords.some((record) =>
    record.fields?.title === "HoneyBerry Immune+"
    && /Proprietary Immune Blend: 57\.5 mg; 115 mg/i.test(record.fields?.supplement_facts ?? "")
  ),
};

if (!qualityChecks.uniqueProductUrls
    || qualityChecks.trackingQueryIdsRemaining !== 0
    || qualityChecks.knownOutOfScopeRecordsRemaining !== 0
    || qualityChecks.proenzolDescriptionsUnder200Characters !== 0
    || qualityChecks.baerbelIngredientSectionsOver1500Characters !== 0
    || !qualityChecks.everydayVitaminCUsesMilligrams
    || !qualityChecks.honeyberryAdultBlendUses115mg) {
  throw new Error(`repair quality checks failed: ${JSON.stringify(qualityChecks)}`);
}

const repairReport = {
  status: "inventory_partial",
  sourceDir,
  outputDir,
  sourceRecords: records.length,
  canonicalUniqueBeforeScope: canonicalRecords.size,
  canonicalDuplicatesRemoved: duplicatesRemoved,
  newlyExcludedByScope: scopeExclusions.length,
  priorProductExclusions: priorExclusions.productExclusions?.length ?? 0,
  outputRecords: repairedRecords.length,
  companyCounts,
  repairs: {
    proDescriptionsRepaired,
    zsazaFactsConflictsResolved: factsConflicts.length,
    baerbelIngredientsSplit,
    pricesNormalized,
    originalImageCandidatesCreated: directImageCandidatesCreated,
    genericGalleryAssetsClassified,
  },
  unresolved: {
    formalProductsJsonGenerated: false,
    semanticEnrichmentPending: repairedRecords.length - semanticCompleteCount,
    fullGalleryVisualReviewPending: repairedRecords.length,
    variantReviewPending: repairedRecords.filter((record) =>
      record._meta?.company === "ProEnzol"
      || record._meta?.variantReview?.reason === "variant_controls_present"
    ).length,
    proenzolFactsImageTranscriptionPending: repairedRecords.filter((record) =>
      record._meta?.company === "ProEnzol" && record.fields?.supplement_facts_image
    ).length,
    directImageCandidateValidationPending: directImageCandidatesCreated,
  },
  qualityChecks,
};

const companyAudit = {
  status: "inventory_partial",
  catalog: {
    ProEnzol: {
      discoveredDetailUrls: 53,
      includedBaseProducts: companyCounts.ProEnzol ?? 0,
      excluded: 1,
      exclusionReason: "veterinary_product",
    },
    "ZSAZA Honey": {
      discoveredDetailUrls: 2,
      includedBaseProducts: companyCounts["ZSAZA Honey"] ?? 0,
      factsImageConflictsResolved: 2,
    },
    "Bärbel Drexel": {
      discoveredUrlReferences: 113,
      canonicalUniqueDetailUrls: 106,
      includedBaseProducts: companyCounts["Bärbel Drexel"] ?? 0,
      bundleOrSetExclusions: priorExclusions.productExclusions?.length ?? 0,
      nonNutritionExclusions: 3,
    },
    KENAY: {
      includedBaseProducts: 0,
      status: "terminal_excluded_multi_brand_retailer",
    },
  },
  totals: {
    outputRecords: repairedRecords.length,
    semanticComplete: semanticCompleteCount,
    apiReady: 0,
  },
};

await writeFile(
  path.join(outputDir, "exclusions.json"),
  `${JSON.stringify(exclusions, null, 2)}\n`,
);
await writeFile(
  path.join(outputDir, "facts-conflicts.json"),
  `${JSON.stringify(factsConflicts, null, 2)}\n`,
);
await writeFile(
  path.join(outputDir, "repair-report.json"),
  `${JSON.stringify(repairReport, null, 2)}\n`,
);
await writeFile(
  path.join(outputDir, "company-audit.json"),
  `${JSON.stringify(companyAudit, null, 2)}\n`,
);

const exported = await writeEnrichProductExport(outputDir, repairedRecords, {
  outputMode: "inventory_partial",
});
if (exported.errors.length > 0) {
  throw new Error(`repaired export still has ${exported.errors.length} structural errors`);
}

console.log(JSON.stringify({
  ...repairReport,
  exportSummary: exported.summary,
  files: exported.files,
}, null, 2));
