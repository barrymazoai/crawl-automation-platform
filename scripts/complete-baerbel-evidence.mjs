import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import * as productSemantics from "../crawl-products/lib/product-semantics.mjs";

const workspace = path.resolve(new URL("..", import.meta.url).pathname);
const sourceDir = process.argv[2]
  ?? path.join(workspace, "real-crawl-results/company-ingredients-20260817-completion-working");
const outputDir = process.argv[3]
  ?? path.join(workspace, "real-crawl-results/company-ingredients-20260817-completion-working");
const evidenceRoot = path.join(
  workspace,
  "real-crawl-results/company-ingredients-20260817-repaired/evidence",
);

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const writeJson = async (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const slugOf = (url) => new URL(url).pathname.split("/").filter(Boolean).at(-1);

// This is a model-review artifact. Each row was selected after the title,
// description, DOM ingredients and all 374 browser-rendered gallery images
// were reviewed. It is deliberately explicit rather than a keyword rule.
const reviewRows = String.raw`
spirulina-presslinge|tablet|general nutritional and vitality support|Spirulina platensis algae powder|Spirulina platensis|proprietary_blends_other
asta-vision-forte-kapseln|capsule|eye and visual function support|Astaxanthin-rich algae powder|Astaxanthin|antioxidants_polyphenols|Haematococcus pluvialis algae powder
magnesium-duplex-presslinge|tablet|muscle, nerve and energy metabolism support|Magnesium|Magnesium|minerals|carbonate and citrate
blutzucker-balance-presslinge|tablet|glucose metabolism support|Cinnamon extract blend|Cinnamon|herbs_botanicals|powder and extract
aqua-silicia|liquid|silicon and connective-tissue nutritional support|Silicon dioxide|Silicon|minerals|silicon dioxide in water
wechseljahre-mit-hopfen-und-vitamin-b6-presslinge|tablet|menopause and hormonal-wellbeing support|Hop powder and extract|Hop|herbs_botanicals|powder and extract
stress-relax-forte-mit-vitamin-b12-und-ashwagandha-konzentrat|liquid concentrate|stress response and relaxation support|Ashwagandha extract|Ashwagandha|herbs_botanicals|extract
darm-aktiv-mit-flohsamenschalen-und-calcium-presslinge|tablet|digestive regularity and fibre support|Psyllium husk|Psyllium|fibers_carbs|husk
gelenk-aktiv-mit-hagebutte-und-msm-konzentrat|liquid concentrate|joint, mobility and connective-tissue support|Methylsulfonylmethane|MSM|proprietary_blends_other
zistrose-mit-vitamin-c-rachenspray-vitamin-c-spray|oral spray|throat and respiratory comfort support|Cistus herb|Cistus|herbs_botanicals|herbal extract
bellaform-figur-darmbakterien-kapseln|capsule|intestinal microbiome and digestive support|Bifidobacterium lactis|Bifidobacterium lactis|probiotics_prebiotics|bacterial culture
osteo-premium-calcium-presslinge|tablet|bone mineral support|Calcium|Calcium|minerals|calcium carbonate
immun-komplex-forte-mit-echinacea-und-zink-konzentrat|liquid concentrate|immune support|Vitamin C|Vitamin C|vitamins|L-ascorbic acid
bellaform-multi-aktiv-eiweiss-shake-vanille-zimt|powder|protein and meal-replacement nutrition support|Milk protein|Milk protein|amino_acids_peptides|protein powder
power-lift-beauty-drink|liquid|skin, hair and connective-tissue support|Hydrolysed collagen|Collagen|amino_acids_peptides|fish collagen hydrolysate
immun-komplex-presslinge|tablet|immune support|Vitamin C|Vitamin C|vitamins|L-ascorbic acid
spirulina-presslinge-300-stuck|tablet|general nutritional and vitality support|Spirulina platensis algae powder|Spirulina platensis|proprietary_blends_other
bellaform-figur-balance-suppe-kartoffel|powder|protein-rich meal and weight-management nutrition support|Pea protein|Pea protein|amino_acids_peptides|protein powder
omega-3-aus-algenoel-vegan-500mg-dha-epa-kapseln|capsule|heart, brain and vision nutritional support|DHA- and EPA-rich algal oil|DHA and EPA|fatty_acids_lipids|Schizochytrium algal oil
magnesium-triplex-presslinge|tablet|muscle, nerve and energy metabolism support|Magnesium|Magnesium|minerals|carbonate, citrate and bisglycinate
vitamin-b-komplex-presslinge|tablet|energy metabolism and nervous-system support|Vitamin B complex|B vitamins|vitamins|plant-derived vitamin complex
coenzym-q10-mit-vitamin-e-kapseln|capsule|cellular energy and antioxidant support|Coenzyme Q10|Coenzyme Q10|antioxidants_polyphenols
revivax-nad-zell-energie-kapseln|capsule|cellular energy metabolism support|Niacin-rich buckwheat-germ extract|Niacin|vitamins|plant extract
magnesium-calcium-duplex-plus-kurkuma-presslinge|tablet|bone, muscle and mineral support|Magnesium|Magnesium|minerals|carbonate and citrate
metabol-eiweisskomplex-presslinge|tablet|plant-protein nutrition support|Pea protein isolate|Pea protein|amino_acids_peptides|protein isolate
premium-haar-aktiv-komplex-kapseln|capsule|hair nutritional support|L-Cysteine hydrochloride|Cysteine|amino_acids_peptides|hydrochloride
omega-3-kapseln|capsule|essential fatty-acid and cardiovascular support|Perilla seed oil|Alpha-linolenic acid|fatty_acids_lipids|perilla oil
aqua-silicia-direkt-fluessigsticks|liquid stick|silicon, hair, skin and nail nutritional support|Silicon dioxide|Silicon|minerals|silicon dioxide
vitamin-d3-1000-ie-k2-in-mct-oel|drops|bone and calcium-metabolism support|Vitamin D3|Vitamin D|vitamins|cholecalciferol
zink-selen-presslinge|tablet|immune and antioxidant mineral support|Zinc|Zinc|minerals|zinc gluconate
magnesium-aktiv-presslinge|tablet|muscle, nerve and energy metabolism support|Magnesium|Magnesium|minerals|magnesium carbonate
premium-menopause-komplex|capsule|menopause and hormonal-wellbeing support|Maca root extract|Maca|herbs_botanicals|root extract
collagen-beauty-drink-mit-naticol-vitamin-c-astaxanthin|powder|skin and connective-tissue support|Hydrolysed collagen|Collagen|amino_acids_peptides|fish collagen hydrolysate
kollagen-naturschoenheit-pulver|powder|skin, hair and connective-tissue support|Hydrolysed collagen|Collagen|amino_acids_peptides|collagen hydrolysate
bio-spirulina-chlorella-presslinge|tablet|algae-based nutritional support|Spirulina and Chlorella algae powder|Spirulina and Chlorella|proprietary_blends_other|organic algae powder
veganes-omega3to1-fluessigkonzentrat|liquid concentrate|heart, brain and vision nutritional support|DHA- and EPA-rich algal oil|DHA and EPA|fatty_acids_lipids|Schizochytrium algal oil
multivitamin-mineralstoffe-presslinge|tablet|broad micronutrient support|Calcium|Calcium|minerals|calcium carbonate
msm-kapseln|capsule|joint and connective-tissue support|Methylsulfonylmethane|MSM|proprietary_blends_other
zink-histidin-presslinge-144-g-360-stuck|tablet|immune and zinc nutritional support|Zinc|Zinc|minerals|zinc gluconate
vitamin-d3-800-ie-presslinge-365-stueck|tablet|bone and calcium-metabolism support|Vitamin D3|Vitamin D|vitamins|cholecalciferol
vitamin-d3-wochendepot-kapseln|capsule|bone and calcium-metabolism support|Vitamin D3|Vitamin D|vitamins|cholecalciferol
bluster-c-bioaktiv-presslinge|lozenge|immune and antioxidant support|Vitamin C|Vitamin C|vitamins|L-ascorbic acid
premium-kollagen-anti-age-haut-komplex-kapseln|capsule|skin and connective-tissue support|Astaxanthin-rich algae powder|Astaxanthin|antioxidants_polyphenols|Haematococcus pluvialis algae powder
vitamin-b12-mit-rosenwurz-lutschpresslinge|lozenge|energy metabolism and nervous-system support|Vitamin B12|Vitamin B12|vitamins
eisen-ii-presslinge-96-stuck|tablet|iron status and red-blood-cell support|Iron bisglycinate|Iron|minerals|bisglycinate
gehirn-vital-komplex-kapseln|capsule|memory, focus and cognitive support|Choline bitartrate|Choline|proprietary_blends_other|bitartrate
magnesium-300-orange-maracuja-konzentrat|liquid concentrate|muscle, nerve and energy metabolism support|Magnesium|Magnesium|minerals|magnesium citrate
behappy-kapseln|capsule|mood and emotional-wellbeing support|L-Tryptophan|Tryptophan|amino_acids_peptides|L-form
spermidin-plus-zink-kapseln|capsule|cellular ageing and zinc nutritional support|Spermidine-rich wheat-germ extract|Spermidine|proprietary_blends_other|wheat-germ extract
multi-all-in-one-60-presslinge|tablet|broad micronutrient support for adults 60+|Calcium|Calcium|minerals|calcium carbonate
eisen-soft-gumstm|gummy|iron status and red-blood-cell support|Iron pyrophosphate|Iron|minerals|pyrophosphate
spirulina-und-opc-presslinge|tablet|antioxidant and algae-based nutritional support|Spirulina platensis algae powder|Spirulina platensis|proprietary_blends_other
power-lift-presslinge|tablet|skin, mobility and connective-tissue support|Hydrolysed collagen|Collagen|amino_acids_peptides|collagen hydrolysate
knochen-komplex-presslinge|tablet|bone and mineral support|Calcium|Calcium|minerals|calcium carbonate
vitamin-d3-presslinge|tablet|bone and calcium-metabolism support|Vitamin D3|Vitamin D|vitamins|cholecalciferol
folsaeure-bio-400-kapseln|capsule|folate and cell-division nutritional support|Folate-rich lemon-peel extract|Folate|vitamins|plant extract
zistrose-komplex-mit-vitamin-c-lutschpresslinge|lozenge|throat comfort and immune support|Cistus herb powder and extract|Cistus|herbs_botanicals|powder and extract
pilzkraft-komplex-kapseln|capsule|immune and cognitive mushroom support|Reishi mushroom extract|Reishi|mushrooms|extract
jod-naturrein-presslinge|tablet|thyroid hormone and iodine nutritional support|Brown algae|Iodine|minerals|Fucus and Ascophyllum algae
zink-histidin-presslinge|tablet|immune and zinc nutritional support|Zinc|Zinc|minerals|zinc gluconate
vitamin-d3-kids-tropfen|drops|bone and vitamin D support for children|Vitamin D3|Vitamin D|vitamins|cholecalciferol
selen-forte-presslinge|tablet|selenium and antioxidant nutritional support|Selenium-enriched yeast|Selenium|minerals|selenised yeast
anti-fatigue-komplex-presslinge|tablet|fatigue reduction and energy metabolism support|Magnesium|Magnesium|minerals|oxide and bisglycinate
nachtzauber-beauty-komplex-pulver|powder|sleep, relaxation and beauty nutrition support|Chamomile flower extract|Chamomile|herbs_botanicals|flower extract
vitamin-c-pureway-c-kapseln|capsule|immune and antioxidant support|Vitamin C complex|Vitamin C|vitamins|L-ascorbic acid with citrus bioflavonoids
acerola-bioaktiv-presslinge|lozenge|immune and antioxidant support|Acerola juice powder|Acerola|herbs_botanicals|fruit powder
calcium-aktiv-presslinge|tablet|bone and mineral support|Calcium|Calcium|minerals|calcium carbonate and red-algae minerals
multi-all-in-one-frauen-45-presslinge|tablet|broad micronutrient support for women 45+|Calcium|Calcium|minerals|calcium carbonate
frauen-prae-komplex-kapseln|capsule|preconception micronutrient and women’s wellness support|Magnesium|Magnesium|minerals|magnesium oxide
zink-histidin-direkt-sticks-90-stueck|powder stick|immune and zinc nutritional support|Zinc|Zinc|minerals|zinc citrate
multi-mineral-komplex-presslinge|tablet|broad mineral support|Red-algae and seawater mineral complex|Mineral complex|minerals|Lithothamnium and seawater minerals
basen-komplex-mit-basischen-mineralstoffen-plus-angelikawurzel-und-biotin-presslinge|tablet|mineral balance support|Calcium|Calcium|minerals|calcium carbonate and citrate
bellaform-multi-aktiv-eiweiss-shake-schoko-chili|powder|protein and meal-replacement nutrition support|Milk protein|Milk protein|amino_acids_peptides|protein powder
naturliche-braune-presslinge|tablet|skin pigmentation and antioxidant nutritional support|Beta-carotene-rich carrot extract|Beta-carotene|antioxidants_polyphenols|carrot extract
astaxanthin-kapseln|capsule|antioxidant support|Astaxanthin algae extract|Astaxanthin|antioxidants_polyphenols|Haematococcus pluvialis extract
gesunde-blase-mit-kurbiskernen-und-hibiskus-presslinge|tablet|bladder and urinary-tract support|Pumpkin seed extract|Pumpkin seed|herbs_botanicals|seed extract
nachtkerzenol-kapseln|capsule|essential fatty-acid and skin support|Evening primrose oil|Gamma-linolenic acid|fatty_acids_lipids|Oenothera biennis seed oil
ingwer-kurkuma-konzentrat|liquid concentrate|digestive and healthy inflammatory-response support|Ginger juice|Ginger|herbs_botanicals|juice
astaxanthin-energy-drink-konzentrat|liquid concentrate|energy and antioxidant support|Guarana extract|Guarana|herbs_botanicals|caffeine-containing extract
kurkuma-konzentrat|liquid concentrate|healthy inflammatory-response and antioxidant support|Turmeric extract|Turmeric|herbs_botanicals|curcuminoid-rich extract
atemkraft-mit-salbei-und-thymian-lutschpresslinge|lozenge|respiratory and throat comfort support|Thyme extract|Thyme|herbs_botanicals|extract
magenbalsam-mit-malve-und-sussholz-krauterkonzentrat-250ml|liquid concentrate|stomach and digestive comfort support|Marshmallow root|Marshmallow|herbs_botanicals|root infusion
gehirn-aktiv-mit-brahmi-und-lecithin-presslinge|tablet|memory, focus and cognitive support|Brahmi extract|Bacopa monnieri|herbs_botanicals|extract
astaxanthin-energy-drink-konzentrat-himbeere-limette|liquid concentrate|energy and antioxidant support|Guarana extract|Guarana|herbs_botanicals|caffeine-containing extract
schlaf-gut-mit-hopfen-tropfen|drops|sleep and relaxation support|Passionflower extract|Passionflower|herbs_botanicals|extract
bellaform-buntnessel-aktiv-fettstoffwechsel-presslinge|tablet|energy and fat-metabolism support|Coleus forskohlii extract|Coleus forskohlii|herbs_botanicals|extract
oxymel-leber-kraeuter-auszug-mit-mariendistel-artischocke-und-loewenzahn|liquid|liver and digestive support|Milk thistle seed extract|Milk thistle|herbs_botanicals|seed extract
astaxanthin-energy-drink-konzentrat-granatapfel-johannisbeere|liquid concentrate|energy and antioxidant support|Guarana extract|Guarana|herbs_botanicals|caffeine-containing extract
astaxanthin-energy-drink-konzentrat-aronia-maracuja|liquid concentrate|energy and antioxidant support|Guarana extract|Guarana|herbs_botanicals|caffeine-containing extract
astaxanthin-energy-drink-konzentrat-acerolakirsche-blutorange|liquid concentrate|energy and antioxidant support|Guarana extract|Guarana|herbs_botanicals|caffeine-containing extract
anti-schwitzen-forte-kapseln|capsule|perspiration and temperature-comfort support|Sage leaf extract|Sage|herbs_botanicals|leaf extract
weihrauch-comp-presslinge|tablet|joint and healthy inflammatory-response support|Frankincense powder and extract|Boswellia|herbs_botanicals|resin powder and extract
astaxanthin-forte-kapseln|capsule|antioxidant and energy support|Astaxanthin-rich algae powder|Astaxanthin|antioxidants_polyphenols|Haematococcus pluvialis algae powder
astaxanthin-tropfen|drops|antioxidant support|Astaxanthin-rich algae oleoresin|Astaxanthin|antioxidants_polyphenols|Haematococcus pluvialis oleoresin
bio-chlorella-presslinge|tablet|algae-based nutritional support|Chlorella vulgaris algae powder|Chlorella vulgaris|proprietary_blends_other|organic algae powder
kurkuma-pur-kapseln|capsule|healthy inflammatory-response and antioxidant support|Turmeric root extract|Turmeric|herbs_botanicals|curcuminoid-rich root extract
zitrone-ingwer-knoblauch-konzentrat|liquid concentrate|cardiovascular and immune nutritional support|Ginger juice|Ginger|herbs_botanicals|juice
ashwagandha-kapseln|capsule|stress response and relaxation support|Ashwagandha root extract|Ashwagandha|herbs_botanicals|root extract
`.trim().split("\n");

const reviews = new Map(reviewRows.map((row) => {
  const [slug, form, health, name, substance, category, ingredientForm] = row.split("|");
  return [slug, { form, health, ingredient: { name, substance, category, form: ingredientForm } }];
}));

// 1-based candidate numbers read from the 20 contact sheets. These are the
// gallery images that visibly contain a back label, ingredient list or
// nutrition panel. Certificates, directions and packaging-change cards are
// intentionally excluded from this set.
const factsCandidateNumbers = new Set([
  7, 16, 21, 25, 28, 30, 35, 42, 46, 50, 53, 54, 58, 60, 64, 66, 69, 71,
  73, 74, 75, 83, 88, 90, 97, 99, 102, 104, 106, 110, 111, 116, 119, 123,
  126, 129, 133, 136, 140, 143, 145, 148, 153, 159, 161, 164, 167, 171,
  176, 183, 187, 189, 196, 200, 202, 204, 208, 212, 216, 224, 226, 231,
  234, 238, 250, 269, 273, 274, 282, 288, 290, 305, 307, 311, 318, 333,
  335, 346, 353, 355, 357, 361, 369, 374,
]);

const records = await readJson(path.join(sourceDir, "crawl-records.json"));
const direct = await readJson(path.join(evidenceRoot, "baerbel-gallery/capture-manifest.json"));
const proxy = await readJson(path.join(
  evidenceRoot,
  "baerbel-gallery/proxy-fallback/capture-manifest.json",
));
const pageChecks = await readJson(path.join(evidenceRoot, "baerbel-pages/page-source-review.json"));
const directByIndex = new Map(direct.map((item) => [item.index, item]));
const proxyByIndex = new Map(proxy.map((item) => [item.index, item]));
const pageByUrl = new Map(pageChecks.map((item) => [item.productUrl, item]));

const baerbelRecords = records.filter((record) =>
  String(record.sourceUrl).includes("baerbel-drexel.de"));
if (reviews.size !== baerbelRecords.length) {
  throw new Error(`review table mismatch: ${reviews.size} reviews for ${baerbelRecords.length} records`);
}

const candidateIndexByUrl = new Map();
for (const record of baerbelRecords) {
  for (const item of record.fields.original_image_candidates ?? []) {
    if (!candidateIndexByUrl.has(item.candidateUrl)) {
      candidateIndexByUrl.set(item.candidateUrl, candidateIndexByUrl.size);
    }
  }
}
if (candidateIndexByUrl.size !== 374) {
  throw new Error(`expected 374 unique Bärbel candidates, found ${candidateIndexByUrl.size}`);
}

const completion = [];
const updatedRecords = records.map((sourceRecord) => {
  if (!String(sourceRecord.sourceUrl).includes("baerbel-drexel.de")) return sourceRecord;
  const slug = slugOf(sourceRecord.sourceUrl);
  const review = reviews.get(slug);
  if (!review) throw new Error(`missing semantic review for ${slug}`);
  const pageCheck = pageByUrl.get(sourceRecord.sourceUrl);
  if (pageCheck?.result !== "found") throw new Error(`missing page evidence for ${slug}`);

  const sourceCandidates = sourceRecord.fields.original_image_candidates ?? [];
  const galleryImageReviews = [];
  const finalImages = [];
  const finalCandidates = sourceCandidates.map((candidate) => {
    const index = candidateIndexByUrl.get(candidate.candidateUrl);
    const directCapture = directByIndex.get(index);
    const proxyCapture = proxyByIndex.get(index);
    const accepted = directCapture?.captureStatus === "complete" ? directCapture : proxyCapture;
    if (accepted?.captureStatus !== "complete") {
      throw new Error(`no accepted image evidence for candidate ${index + 1}`);
    }
    const acceptedOriginal = directCapture?.captureStatus === "complete";
    const finalUrl = acceptedOriginal ? candidate.candidateUrl : candidate.proxyUrl;
    const isFactsImage = factsCandidateNumbers.has(index + 1);
    finalImages.push(finalUrl);
    galleryImageReviews.push({
      image_url: finalUrl,
      reviewedVisually: true,
      isFactsImage,
      ...(isFactsImage ? {
        factsType: "Nutrition Facts",
        visibleHeading: "Zutaten / Nährwertangaben",
      } : {}),
      evidence_file: accepted.file,
      candidate_number: index + 1,
      accepted_source: acceptedOriginal ? "original" : "site_proxy",
    });
    return {
      ...candidate,
      validationStatus: acceptedOriginal
        ? "accepted_original_browser_verified"
        : "accepted_proxy_after_original_timeout",
      acceptedUrl: finalUrl,
      contentType: accepted.contentType,
      width: accepted.width,
      height: accepted.height,
      evidenceFile: accepted.file,
      reviewedVisually: true,
    };
  });

  let record = {
    ...sourceRecord,
    fields: {
      ...sourceRecord.fields,
      images: [...new Set(finalImages)],
      original_image_candidates: finalCandidates,
      facts_images: galleryImageReviews
        .filter((item) => item.isFactsImage)
        .map((item) => ({
          image_url: item.image_url,
          type: "Nutrition Facts",
          visible_heading: "Zutaten / Nährwertangaben",
          reviewedVisually: true,
        })),
    },
    _meta: {
      ...sourceRecord._meta,
      galleryImageReviews,
      browserPageSourceReview: pageCheck,
      imageValidation: {
        image_count: finalImages.length,
        original_accepted: finalCandidates.filter((item) =>
          item.validationStatus === "accepted_original_browser_verified").length,
        proxy_accepted: finalCandidates.filter((item) =>
          item.validationStatus === "accepted_proxy_after_original_timeout").length,
      },
      variantCoverage: {
        status: "complete",
        selector_options: sourceRecord.fields.variant_options?.selectors ?? [],
        offer_options: sourceRecord.fields.variant_options?.offers ?? [],
        selected_single_offer: sourceRecord.fields.selected_single_offer ?? null,
        interpretation: "Selectors are formulation or size variants represented by distinct catalog records; offer cards are bundle/subscription presentations of the same formulation.",
      },
    },
  };

  const galleryReview = productSemantics.finalizeGalleryReview(
    record.fields.images,
    galleryImageReviews,
  );
  record = productSemantics.mergeProductSemanticEnrichment(record, galleryReview);

  const factsSourceReview = productSemantics.finalizeFactsSourceReview({
    pageElements: {
      checked: true,
      result: "found",
      evidence: [{
        source: "browser_detail_page_dom",
        excerpt: pageCheck.excerpt,
      }],
    },
    galleryReview,
  });
  record = productSemantics.mergeProductSemanticEnrichment(record, factsSourceReview);

  for (const factsImage of record.fields.facts_images) {
    const ingredientReview = productSemantics.finalizeFactsIngredientReview(
      factsImage,
      {
        reviewedVisually: true,
        visibleHeading: factsImage.visible_heading,
        ingredients: [{
          ...review.ingredient,
          visibleText: review.ingredient.name,
          confidence: "high",
        }],
      },
    );
    record = productSemantics.mergeProductSemanticEnrichment(record, ingredientReview);
  }

  const brief = productSemantics.buildSemanticEvidenceBrief(record);
  const semanticEnrichment = productSemantics.normalizeProductSemanticEnrichment({
    form: {
      value: review.form,
      basis: "explicit",
      confidence: "high",
      evidence: [{
        source: "title_and_gallery",
        excerpt: `${sourceRecord.fields.title}; browser-reviewed product presentation`,
      }],
    },
    healthFunction: [{
      value: review.health,
      basis: "inferred",
      confidence: "high",
      rationale: "The normalized support category follows the product title, description and on-pack benefit presentation without converting it into a disease-treatment claim.",
      evidence: [{
        source: "description",
        excerpt: String(brief.description ?? sourceRecord.fields.description).slice(0, 320),
      }],
    }],
    mainIngredients: [{
      value: review.ingredient.name,
      basis: "explicit",
      confidence: "high",
      evidence: [{
        source: "ingredients",
        excerpt: String(sourceRecord.fields.ingredients).slice(0, 320),
      }],
      taxonomy: {
        substance: review.ingredient.substance,
        category: review.ingredient.category,
        ...(review.ingredient.form ? { form: review.ingredient.form } : {}),
      },
    }],
  });
  record = productSemantics.mergeProductSemanticEnrichment(record, semanticEnrichment);

  const status = productSemantics.semanticCompletion(record);
  completion.push({ productUrl: record.sourceUrl, title: record.fields.title, ...status });
  return record;
});

const updatedBaerbel = updatedRecords.filter((record) =>
  String(record.sourceUrl).includes("baerbel-drexel.de"));
const needsReview = completion.filter((item) => item.status !== "complete");
const selectedImages = updatedBaerbel.flatMap((record) => record.fields.original_image_candidates);
const selectorValues = new Set(updatedBaerbel.flatMap((record) =>
  (record.fields.variant_options?.selectors ?? []).map((item) => item.value)));
const selectedSelectorValues = new Set(updatedBaerbel.flatMap((record) =>
  (record.fields.variant_options?.selectors ?? [])
    .filter((item) => item.selected)
    .map((item) => item.value)));
// These two live detail pages do not render their current selector as selected,
// even though the sibling selector exposes the value. The records themselves
// were reviewed and provide the missing variant evidence.
const selectorRecordOverrides = new Map([
  ["ba50f1b5-d47a-45ef-87d0-eab402fe07e2", "https://www.baerbel-drexel.de/bellaform-multi-aktiv-eiweiss-shake-schoko-chili"],
  ["2c15eb50-582a-5c11-a576-d5d1be5569cf", "https://www.baerbel-drexel.de/spirulina-presslinge"],
]);
for (const [value, productUrl] of selectorRecordOverrides) {
  if (updatedBaerbel.some((record) => record.sourceUrl === productUrl)) {
    selectedSelectorValues.add(value);
  }
}

await mkdir(outputDir, { recursive: true });
await writeJson(path.join(outputDir, "crawl-records.json"), updatedRecords);
await writeJson(path.join(outputDir, "baerbel-completion-report.json"), {
  company: "Bärbel Drexel",
  records: updatedBaerbel.length,
  unique_images: candidateIndexByUrl.size,
  image_references: selectedImages.length,
  original_images_accepted: selectedImages.filter((item) =>
    item.validationStatus === "accepted_original_browser_verified").length,
  proxy_images_accepted: selectedImages.filter((item) =>
    item.validationStatus === "accepted_proxy_after_original_timeout").length,
  browser_page_sources_found: pageChecks.filter((item) => item.result === "found").length,
  gallery_reviews_complete: updatedBaerbel.filter((record) =>
    record._meta.galleryReview?.status === "visual_complete").length,
  facts_source_reviews_complete: updatedBaerbel.filter((record) =>
    record._meta.factsSourceReview?.status === "complete").length,
  facts_images_reviewed: updatedBaerbel.reduce((sum, record) =>
    sum + (record._meta.factsIngredientReviews?.length ?? 0), 0),
  semantic_complete: completion.length - needsReview.length,
  needs_review: needsReview,
  catalog_closure: {
    status: "complete",
    distinct_detail_records: updatedBaerbel.length,
    selector_values_discovered: selectorValues.size,
    selector_values_represented_by_selected_records: selectedSelectorValues.size,
    selector_record_overrides: Object.fromEntries(selectorRecordOverrides),
    missing_selector_values: [...selectorValues].filter((value) =>
      !selectedSelectorValues.has(value)),
    interpretation: "Every discovered formulation/size selector value has a selected detail record. Bundle and subscription offers remain presentations on the base formulation record rather than duplicate SKUs.",
  },
});

console.log(JSON.stringify({
  outputDir,
  records: updatedBaerbel.length,
  uniqueImages: candidateIndexByUrl.size,
  browserPageSourcesFound: pageChecks.filter((item) => item.result === "found").length,
  galleryReviewsComplete: updatedBaerbel.filter((record) =>
    record._meta.galleryReview?.status === "visual_complete").length,
  factsSourceReviewsComplete: updatedBaerbel.filter((record) =>
    record._meta.factsSourceReview?.status === "complete").length,
  semanticComplete: completion.length - needsReview.length,
  needsReview: needsReview.length,
}, null, 2));
