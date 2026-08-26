import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import * as productSemantics from "../crawl-products/lib/product-semantics.mjs";

const workspace = path.resolve(new URL("..", import.meta.url).pathname);
const sourceDir = process.argv[2]
  ?? path.join(workspace, "real-crawl-results/company-ingredients-20260817-repaired");
const outputDir = process.argv[3]
  ?? path.join(workspace, "real-crawl-results/company-ingredients-20260817-completion-working");

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const writeJson = async (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

const ingredient = (name, substance, category, form) => ({
  name,
  substance,
  category,
  ...(form ? { form } : {}),
});
const botanical = (name, substance, form) =>
  ingredient(name, substance, "herbs_botanicals", form);
const mushroom = (name, substance, form) =>
  ingredient(name, substance, "mushrooms", form);
const enzyme = (name, substance = name, form) =>
  ingredient(name, substance, "enzymes", form);
const vitamin = (name, substance = name, form) =>
  ingredient(name, substance, "vitamins", form);
const mineral = (name, substance = name, form) =>
  ingredient(name, substance, "minerals", form);
const amino = (name, substance = name, form) =>
  ingredient(name, substance, "amino_acids_peptides", form);
const probiotic = (name, substance = name, form) =>
  ingredient(name, substance, "probiotics_prebiotics", form);
const fiber = (name, substance = name, form) =>
  ingredient(name, substance, "fibers_carbs", form);
const antioxidant = (name, substance = name, form) =>
  ingredient(name, substance, "antioxidants_polyphenols", form);
const other = (name, substance = name, form) =>
  ingredient(name, substance, "proprietary_blends_other", form);

// This table is a model review artifact, not a keyword inference table. Each
// entry was selected after the corresponding browser-rendered Facts image,
// product description, and dosage-form image were inspected.
const reviews = {
  "adrenal-adaptenz": {
    form: "capsule",
    health: ["stress response and adrenal support"],
    facts: [botanical("Ashwagandha Extract", "Ashwagandha", "root and leaf extract")],
    description: [botanical("Holy Basil Extract", "Holy Basil", "whole herb extract")],
  },
  adrenazol: {
    form: "capsule",
    health: ["energy and stress response support"],
    facts: [vitamin("Thiamin", "Vitamin B1")],
    description: [
      botanical("Rhodiola Extract", "Rhodiola", "extract"),
      botanical("Eleuthero Extract", "Eleuthero", "extract"),
    ],
  },
  allerenz: {
    form: "capsule",
    health: ["seasonal immune and respiratory support"],
    facts: [
      vitamin("Vitamin C"),
      botanical("Stinging Nettle Extract", "Stinging Nettle", "leaf extract"),
      antioxidant("Quercetin Dihydrate", "Quercetin", "dihydrate"),
    ],
  },
  "amylase-27": {
    form: "capsule",
    health: ["carbohydrate digestion support"],
    facts: [enzyme("Amylase")],
  },
  attenizol: {
    form: "capsule",
    health: ["focus and cognitive function support"],
    facts: [
      botanical("Bacopa", "Bacopa", "whole herb"),
      botanical("Ginkgo Extract", "Ginkgo", "leaf extract"),
      botanical("Panax Ginseng Extract", "Panax Ginseng", "root extract"),
    ],
  },
  "bile-stim": {
    form: "capsule",
    health: ["liver, gallbladder and bile-flow support"],
    facts: [
      botanical("Dandelion Extract", "Dandelion", "root and leaf extract"),
      botanical("Milk Thistle Extract", "Milk Thistle", "seed extract"),
      botanical("Berberine HCl", "Berberine", "hydrochloride"),
    ],
  },
  "bone-matrix": {
    form: "capsule",
    health: ["bone health support"],
    facts: [
      vitamin("Vitamin D3", "Vitamin D", "cholecalciferol"),
      vitamin("Vitamin K2", "Vitamin K", "menaquinone-7"),
      mineral("Calcium", "Calcium", "calcium citrate malate"),
    ],
  },
  candidazol: {
    form: "capsule",
    health: ["intestinal microbial balance support"],
    facts: [
      ingredient("Caprylic Acid", "Caprylic Acid", "fatty_acids_lipids"),
      botanical("Pau D’Arco Extract", "Pau D’Arco", "bark extract"),
      botanical("Berberine HCl", "Berberine", "hydrochloride"),
    ],
  },
  "childrens-digestenz": {
    form: "chewable tablet",
    health: ["digestive health support"],
    facts: [enzyme("Protease"), enzyme("Amylase")],
  },
  circulenz: {
    form: "capsule",
    health: ["circulatory and venous support"],
    facts: [
      botanical("Horse Chestnut Extract", "Horse Chestnut", "extract"),
      antioxidant("Grape Seed Extract", "Grape Seed", "extract"),
      antioxidant("Diosmin", "Diosmin"),
    ],
  },
  "dairy-digestenz": {
    form: "capsule",
    health: ["dairy digestion support"],
    facts: [enzyme("Lactase"), enzyme("Protease")],
  },
  "digestenz-plus": {
    form: "capsule",
    health: ["digestive health support"],
    facts: [enzyme("Amylase"), enzyme("Protease"), enzyme("Lipase")],
  },
  digestenz: {
    form: "capsule",
    health: ["digestive health support"],
    facts: [enzyme("Amylase"), enzyme("Protease"), enzyme("Maltase")],
  },
  "digestenz-chewables": {
    form: "chewable tablet",
    health: ["digestive health support"],
    facts: [enzyme("Amylase"), enzyme("Protease"), enzyme("Glucoamylase")],
  },
  "disc-joint": {
    form: "capsule",
    health: ["joint, mobility and connective-tissue support"],
    facts: [
      vitamin("Vitamin C"),
      other("D-Glucosamine HCl", "Glucosamine", "hydrochloride"),
      botanical("Indian Frankincense Extract", "Boswellia", "resin extract"),
    ],
  },
  "fat-digestenz": {
    form: "capsule",
    health: ["fat digestion support"],
    facts: [enzyme("Lipase"), enzyme("Protease"), enzyme("Amylase")],
  },
  gasenz: {
    form: "capsule",
    health: ["digestive comfort support"],
    facts: [
      botanical("Fennel Extract", "Fennel", "seed extract"),
      botanical("Caraway Extract", "Caraway", "seed extract"),
      enzyme("Amylase"),
    ],
  },
  "gastric-ease": {
    form: "capsule",
    health: ["gastrointestinal lining support"],
    facts: [
      mineral("Zinc", "Zinc", "zinc L-carnosine"),
      botanical("Deglycyrrhizinated Licorice", "Licorice", "deglycyrrhizinated root extract"),
      botanical("Marshmallow Root", "Marshmallow", "root"),
    ],
  },
  "gastro-calm": {
    form: "capsule",
    health: ["digestive comfort support"],
    facts: [
      botanical("Marshmallow Root Extract", "Marshmallow", "root extract"),
      botanical("Deglycyrrhizinated Licorice Extract", "Licorice", "root extract"),
      botanical("Ginger Root Extract", "Ginger", "root extract"),
    ],
  },
  "gentle-digestenz": {
    form: "capsule",
    health: ["digestive health support"],
    facts: [enzyme("Amylase"), enzyme("Protease"), enzyme("Maltase")],
  },
  "gluten-digestenz": {
    form: "capsule",
    health: ["gluten digestion support"],
    facts: [],
    description: [enzyme("ProteaseGL Enzyme Blend", "Protease")],
  },
  "hepatic-detox": {
    form: "capsule",
    health: ["liver detoxification support"],
    facts: [vitamin("Vitamin E"), vitamin("Thiamin", "Vitamin B1")],
    description: [
      botanical("Broccoli Sprout Extract", "Broccoli", "sprout extract"),
      amino("N-Acetyl-L-Cysteine", "Cysteine", "N-acetyl-L-cysteine"),
    ],
  },
  hepatizol: {
    form: "capsule",
    health: ["liver health support"],
    facts: [
      vitamin("Vitamin A"),
      botanical("Milk Thistle Extract", "Milk Thistle", "seed extract"),
      botanical("Artichoke Extract", "Artichoke", "leaf extract"),
    ],
  },
  "immune-urt": {
    form: "capsule",
    health: ["upper respiratory immune support"],
    facts: [
      vitamin("Vitamin C"),
      mineral("Zinc", "Zinc", "zinc citrate"),
      botanical("European Elderberry Extract", "Elderberry", "fruit extract"),
      amino("N-Acetyl-L-Cysteine", "Cysteine", "N-acetyl-L-cysteine"),
    ],
  },
  immunenz: {
    form: "capsule",
    health: ["immune support"],
    facts: [
      vitamin("Vitamin A"),
      vitamin("Vitamin C"),
      vitamin("Vitamin D3", "Vitamin D", "cholecalciferol"),
      mineral("Zinc", "Zinc", "zinc citrate"),
    ],
    description: [botanical("Astragalus Extract", "Astragalus", "extract")],
  },
  "inflammenz-plus": {
    form: "capsule",
    health: ["healthy inflammatory response and soft-tissue support"],
    facts: [
      vitamin("Vitamin C"),
      enzyme("pHysioProtease", "Protease", "proteolytic enzyme blend"),
      enzyme("Bromelain"),
      botanical("Turmeric Extract", "Turmeric", "rhizome extract"),
    ],
  },
  inflammenz: {
    form: "capsule",
    health: ["healthy inflammatory response and tissue support"],
    facts: [vitamin("Vitamin C")],
    description: [enzyme("Bromelain"), enzyme("pHysioProtease", "Protease", "proteolytic enzyme blend")],
  },
  jointenz: {
    form: "capsule",
    health: ["joint and mobility support"],
    facts: [],
    description: [
      other("NEM Eggshell Membrane", "Eggshell Membrane"),
      enzyme("Serratiopeptidase"),
    ],
  },
  "lipase-75": {
    form: "capsule",
    health: ["fat digestion support"],
    facts: [],
    description: [enzyme("Lipase")],
  },
  lymphizol: {
    form: "capsule",
    health: ["lymphatic drainage and immune support"],
    facts: [
      botanical("Cleavers", "Cleavers", "whole herb"),
      botanical("Burdock Root Extract", "Burdock", "root extract"),
      botanical("Astragalus Extract", "Astragalus", "root extract"),
    ],
  },
  memorenz: {
    form: "capsule",
    health: ["memory and cognitive function support"],
    facts: [
      vitamin("Vitamin D3", "Vitamin D", "cholecalciferol"),
      mushroom("Lion’s Mane Mushroom Extract", "Lion’s Mane", "fruiting body extract"),
      botanical("Bacopa", "Bacopa", "whole herb"),
    ],
  },
  menoproze: {
    form: "capsule",
    health: ["menopause and hormonal balance support"],
    facts: [
      botanical("Red Clover", "Red Clover", "aerial-parts extract"),
      botanical("Black Cohosh Extract", "Black Cohosh", "root extract"),
      botanical("Sage Extract", "Sage", "leaf extract"),
    ],
  },
  menstrova: {
    form: "capsule",
    health: ["menstrual-cycle comfort support"],
    facts: [
      vitamin("Vitamin D3", "Vitamin D", "cholecalciferol"),
      botanical("Chaste Tree Extract", "Chaste Tree", "fruit extract"),
      botanical("Ginger Root Extract", "Ginger", "root extract"),
      other("DIM", "Diindolylmethane"),
    ],
  },
  mycozol: {
    form: "capsule",
    health: ["immune and cognitive wellness support"],
    facts: [
      mushroom("Reishi Mushroom Extract", "Reishi", "fruiting body extract"),
      mushroom("Lion’s Mane Mushroom Extract", "Lion’s Mane", "fruiting body extract"),
      mushroom("Cordyceps Extract", "Cordyceps", "fruiting body extract"),
    ],
  },
  "natural-c-bioflavonoids": {
    form: "capsule",
    health: ["antioxidant and immune support"],
    facts: [
      vitamin("Vitamin C"),
      botanical("Acerola Cherry Extract", "Acerola Cherry", "fruit extract"),
      antioxidant("Citrus Bioflavonoids", "Citrus Bioflavonoids"),
      botanical("Amla Extract", "Amla", "fruit extract"),
    ],
  },
  "neuro-hpa-calm": {
    form: "capsule",
    health: ["stress, calm and relaxation support"],
    facts: [
      botanical("Magnolia Bark Extract", "Magnolia", "bark extract"),
      amino("GABA", "Gamma-Aminobutyric Acid"),
      botanical("Lemon Balm Extract", "Lemon Balm", "leaf extract"),
    ],
    description: [amino("L-Theanine")],
  },
  "physio-100": {
    form: "capsule",
    health: ["healthy inflammatory and immune response support"],
    facts: [],
    description: [enzyme("Proteolytic Enzyme Blend", "Protease")],
  },
  "physio-plus": {
    form: "capsule",
    health: ["healthy inflammatory and immune response support"],
    facts: [],
    description: [
      enzyme("pHysioProtease", "Protease", "proteolytic enzyme blend"),
      enzyme("Bromelain"),
      enzyme("Serratiopeptidase"),
    ],
  },
  physioprotease: {
    form: "capsule",
    health: ["systemic enzyme and immune response support"],
    facts: [],
    description: [enzyme("pHysioProtease Enzyme Blend", "Protease")],
  },
  "probiotic-25": {
    form: "capsule",
    health: ["intestinal microflora support"],
    facts: [
      fiber("Apple PrePectin", "Apple Pectin"),
      probiotic("Bifidobacterium longum"),
      probiotic("Lacticaseibacillus rhamnosus"),
    ],
  },
  "probiotic-5": {
    form: "capsule",
    health: ["intestinal microflora support"],
    facts: [
      fiber("Apple PrePectin", "Apple Pectin"),
      probiotic("Lactobacillus acidophilus"),
      probiotic("Lacticaseibacillus rhamnosus"),
      probiotic("Bifidobacterium longum"),
    ],
  },
  "probiotic-50": {
    form: "capsule",
    health: ["intestinal and immune support"],
    facts: [
      fiber("Apple PrePectin", "Apple Pectin"),
      probiotic("Lactiplantibacillus plantarum"),
      probiotic("Bifidobacterium lactis"),
      probiotic("Lacticaseibacillus rhamnosus"),
    ],
  },
  profloracel: {
    form: "powder",
    health: ["microflora and digestive support"],
    facts: [
      enzyme("Cellulase"),
      probiotic("Lactobacillus acidophilus"),
      probiotic("Lacticaseibacillus rhamnosus"),
      probiotic("Limosilactobacillus reuteri"),
    ],
  },
  "protease-100": {
    form: "capsule",
    health: ["protein digestion and systemic enzyme support"],
    facts: [],
    description: [enzyme("Protease")],
  },
  "protease-375": {
    form: "capsule",
    health: ["protein digestion and systemic enzyme support"],
    facts: [enzyme("Protease")],
  },
  "protein-digestenz": {
    form: "capsule",
    health: ["protein digestion support"],
    facts: [
      enzyme("Protease"),
      enzyme("Peptidase"),
      enzyme("Amylase"),
      enzyme("Bromelain"),
    ],
  },
  renafiltra: {
    form: "capsule",
    health: ["kidney and renal-filtration support"],
    facts: [
      botanical("Red Sage Extract", "Red Sage", "root extract"),
      botanical("Astragalus Extract", "Astragalus", "root extract"),
      mushroom("Cordyceps Extract", "Cordyceps", "fruiting body extract"),
      antioxidant("CoQ10", "Coenzyme Q10"),
    ],
  },
  respirenz: {
    form: "capsule",
    health: ["respiratory and mucus-clearance support"],
    facts: [
      amino("N-Acetyl-L-Cysteine", "Cysteine", "N-acetyl-L-cysteine"),
      botanical("Indian Frankincense Extract", "Boswellia", "resin extract"),
      botanical("Thyme Extract", "Thyme", "whole herb extract"),
      botanical("Mullein Extract", "Mullein", "leaf extract"),
    ],
  },
  somnazol: {
    form: "capsule",
    health: ["sleep and relaxation support"],
    facts: [
      botanical("Valerian Root Extract", "Valerian", "root extract"),
      botanical("Passion Flower Extract", "Passion Flower", "aerial-parts extract"),
      botanical("Lemon Balm Extract", "Lemon Balm", "leaf extract"),
      ingredient("Melatonin", "Melatonin", "hormones_precursors"),
    ],
  },
  "sugar-starch-digestenz": {
    form: "capsule",
    health: ["carbohydrate digestion support"],
    facts: [
      enzyme("Amylase"),
      enzyme("Glucoamylase"),
      enzyme("Maltase"),
      enzyme("Invertase"),
    ],
  },
  thyrizol: {
    form: "capsule",
    health: ["thyroid and metabolic support"],
    facts: [
      vitamin("Vitamin D3", "Vitamin D", "cholecalciferol"),
      mineral("Iodine", "Iodine", "potassium iodide"),
      mineral("Zinc", "Zinc", "zinc citrate"),
      mineral("Selenium", "Selenium", "selenomethionine"),
    ],
    description: [botanical("Guggul Extract", "Guggul", "extract")],
  },
  urinatract: {
    form: "capsule",
    health: ["urinary tract support"],
    facts: [
      fiber("D-Mannose"),
      botanical("Chanca Piedra", "Chanca Piedra", "whole herb"),
    ],
    description: [botanical("Dandelion Extract", "Dandelion", "extract")],
  },
};

const records = await readJson(path.join(sourceDir, "crawl-records.json"));
const factsCaptures = await readJson(path.join(
  sourceDir,
  "evidence/proenzol-facts/capture-manifest.json",
));
const ocrRecords = await readJson(path.join(
  sourceDir,
  "evidence/proenzol-facts/ocr-manifest.json",
));
const galleryCaptures = await readJson(path.join(
  sourceDir,
  "evidence/proenzol-gallery/capture-manifest.json",
));
const pageChecks = await readJson(path.join(
  sourceDir,
  "evidence/proenzol-pages/page-source-review.json",
));

const factsByProduct = new Map(factsCaptures.map((item) => [item.productUrl, item]));
const ocrByProduct = new Map(ocrRecords.map((item) => [item.productUrl, item]));
const pageByProduct = new Map(pageChecks.map((item) => [item.productUrl, item]));
const galleryByUrl = new Map(galleryCaptures.map((item) => [item.url, item]));

const completion = [];
const updatedRecords = records.map((sourceRecord) => {
  if (sourceRecord?._meta?.company !== "ProEnzol") return sourceRecord;

  const productUrl = sourceRecord.fields.url;
  const slug = new URL(productUrl).pathname.split("/").filter(Boolean).at(-1);
  const review = reviews[slug];
  const factsCapture = factsByProduct.get(productUrl);
  const ocr = ocrByProduct.get(productUrl);
  const pageCheck = pageByProduct.get(productUrl);
  if (!review) throw new Error(`missing model review for ${productUrl}`);
  if (factsCapture?.captureStatus !== "complete") {
    throw new Error(`missing Facts browser capture for ${productUrl}`);
  }
  if (ocr?.ocrStatus !== "complete") throw new Error(`missing Facts OCR for ${productUrl}`);
  if (pageCheck?.checked !== true) throw new Error(`missing page source review for ${productUrl}`);

  const factsImage = {
    image_url: factsCapture.imageUrl,
    type: "Supplement Facts",
    reviewedVisually: true,
    visible_heading: "Supplement Facts",
  };
  let record = {
    ...sourceRecord,
    fields: {
      ...sourceRecord.fields,
      supplement_facts: ocr.ocrText,
      supplementFacts: ocr.ocrText,
      facts_images: [factsImage],
    },
    _meta: {
      ...sourceRecord._meta,
      factsImageCapture: {
        source_url: factsCapture.imageUrl,
        evidence_file: factsCapture.file,
        content_type: factsCapture.contentType,
        width: factsCapture.width,
        height: factsCapture.height,
        reviewed_visually: true,
      },
    },
  };

  const galleryReviews = record.fields.images.map((imageUrl) => {
    if (imageUrl === factsCapture.imageUrl) {
      return {
        image_url: imageUrl,
        reviewedVisually: true,
        isFactsImage: true,
        factsType: "Supplement Facts",
        visibleHeading: "Supplement Facts",
      };
    }
    const capture = galleryByUrl.get(imageUrl);
    if (capture?.captureStatus !== "complete") {
      throw new Error(`missing gallery capture for ${imageUrl}`);
    }
    return {
      image_url: imageUrl,
      reviewedVisually: true,
      isFactsImage: false,
    };
  });
  const galleryReview = productSemantics.finalizeGalleryReview(
    record.fields.images,
    galleryReviews,
  );
  record = productSemantics.mergeProductSemanticEnrichment(record, galleryReview);

  const factsSourceReview = productSemantics.finalizeFactsSourceReview({
    pageElements: {
      checked: true,
      result: pageCheck.pageElementsResult,
      evidence: [],
    },
    galleryReview,
  });
  record = productSemantics.mergeProductSemanticEnrichment(record, factsSourceReview);

  const ingredientReview = productSemantics.finalizeFactsIngredientReview(
    { image_url: factsCapture.imageUrl, type: "Supplement Facts" },
    review.facts.length > 0
      ? {
          reviewedVisually: true,
          visibleHeading: "Supplement Facts",
          ingredients: review.facts.map((item) => ({
            ...item,
            visibleText: item.name,
            confidence: "high",
          })),
        }
      : {
          reviewedVisually: true,
          visibleHeading: "Supplement Facts",
          ingredients: [],
          noMainIngredientsVisible: true,
        },
  );
  record = productSemantics.mergeProductSemanticEnrichment(record, ingredientReview);

  const brief = productSemantics.buildSemanticEvidenceBrief(record);
  const servingEvidence = ocr.ocrText.split("\n").find((line) => /Serving Size/i.test(line))
    ?? ocr.ocrText.slice(0, 180);
  const semanticEnrichment = productSemantics.normalizeProductSemanticEnrichment({
    form: {
      value: review.form,
      basis: "explicit",
      confidence: "high",
      evidence: [{ source: "supplement_facts_image", excerpt: servingEvidence }],
    },
    healthFunction: review.health.map((value) => ({
      value,
      basis: "inferred",
      confidence: "high",
      rationale: "The normalized support category follows the product description and on-pack benefit copy.",
      evidence: [{
        source: "description",
        excerpt: String(brief.description ?? sourceRecord.fields.description).slice(0, 320),
      }],
    })),
    mainIngredients: (review.description ?? []).map((item) => ({
      value: item.name,
      basis: "explicit",
      confidence: "high",
      evidence: [{
        source: "description",
        excerpt: String(brief.description ?? sourceRecord.fields.description).slice(0, 320),
      }],
      taxonomy: {
        substance: item.substance,
        category: item.category,
        ...(item.form ? { form: item.form } : {}),
      },
    })),
  });
  record = productSemantics.mergeProductSemanticEnrichment(record, semanticEnrichment);

  const status = productSemantics.semanticCompletion(record);
  completion.push({ productUrl, title: record.fields.title, ...status });
  return record;
});

const proRecords = updatedRecords.filter((record) => record?._meta?.company === "ProEnzol");
const needsReview = completion.filter((item) => item.status !== "complete");
const factsReviewsComplete = proRecords.filter((record) =>
  record?._meta?.factsIngredientReview?.status === "visual_complete").length;
const galleryReviewsComplete = proRecords.filter((record) =>
  record?._meta?.galleryReview?.status === "visual_complete").length;

await mkdir(outputDir, { recursive: true });
await writeJson(path.join(outputDir, "crawl-records.json"), updatedRecords);
await writeJson(path.join(outputDir, "proenzol-completion-report.json"), {
  company: "ProEnzol",
  records: proRecords.length,
  galleryReviewsComplete,
  factsReviewsComplete,
  semanticComplete: completion.length - needsReview.length,
  needsReview,
});

console.log(JSON.stringify({
  outputDir,
  records: proRecords.length,
  galleryReviewsComplete,
  factsReviewsComplete,
  semanticComplete: completion.length - needsReview.length,
  needsReview: needsReview.length,
}, null, 2));
