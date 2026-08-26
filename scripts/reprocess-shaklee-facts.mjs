import fs from "node:fs/promises";
import path from "node:path";
import {
  finalizeFactsIngredientReview,
} from "/Users/songtianjian/conductor/workspaces/spider-agent/beirut/skills/crawl-products/lib/product-semantics.mjs";
import {
  writeEnrichProductExport,
} from "/Users/songtianjian/conductor/workspaces/spider-agent/beirut/skills/crawl-products/lib/enrich-product-output.mjs";

const workspace = "/Users/songtianjian/Documents/browser-scaperskill";
const inputPath = path.join(
  workspace,
  "output/shaklee-all/api-ready-v2/crawl-records.json",
);
const reviewRoot = path.join(workspace, "output/shaklee-all/facts-reprocess");
const manifestPath = path.join(reviewRoot, "manifest.json");
const outputDir = path.join(workspace, "output/shaklee-all/api-ready-v3");

function ingredient(name, category, substance = name, form = "") {
  return {
    name,
    visibleText: name,
    substance,
    ...(form ? { form } : {}),
    category,
  };
}

const vitamin = (name, substance = name, form = "") =>
  ingredient(name, "vitamins", substance, form);
const mineral = (name, substance = name, form = "") =>
  ingredient(name, "minerals", substance, form);
const amino = (name, substance = name, form = "") =>
  ingredient(name, "amino_acids_peptides", substance, form);
const botanical = (name, substance = name, form = "") =>
  ingredient(name, "herbs_botanicals", substance, form);
const mushroom = (name, substance = name, form = "") =>
  ingredient(name, "mushrooms", substance, form);
const lipid = (name, substance = name, form = "") =>
  ingredient(name, "fatty_acids_lipids", substance, form);
const probiotic = (name, substance = name, form = "") =>
  ingredient(name, "probiotics_prebiotics", substance, form);
const enzyme = (name, substance = name, form = "") =>
  ingredient(name, "enzymes", substance, form);
const antioxidant = (name, substance = name, form = "") =>
  ingredient(name, "antioxidants_polyphenols", substance, form);
const fiber = (name, substance = name, form = "") =>
  ingredient(name, "fibers_carbs", substance, form);
const other = (name, substance = name, form = "") =>
  ingredient(name, "proprietary_blends_other", substance, form);

const coreVitamins = [
  vitamin("Vitamin A"),
  vitamin("Vitamin C"),
  vitamin("Vitamin D"),
  vitamin("Vitamin E"),
  vitamin("Vitamin K"),
  vitamin("Thiamin", "Vitamin B1"),
  vitamin("Riboflavin", "Vitamin B2"),
  vitamin("Niacin", "Vitamin B3"),
  vitamin("Vitamin B6"),
  vitamin("Folate", "Vitamin B9"),
  vitamin("Vitamin B12"),
  vitamin("Biotin", "Vitamin B7"),
  vitamin("Pantothenic Acid", "Vitamin B5"),
];

const coreMinerals = [
  mineral("Calcium"),
  mineral("Iron"),
  mineral("Iodine"),
  mineral("Magnesium"),
  mineral("Zinc"),
  mineral("Selenium"),
  mineral("Copper"),
  mineral("Manganese"),
  mineral("Chromium"),
  mineral("Molybdenum"),
  mineral("Potassium"),
];

const broadMulti = [...coreVitamins, ...coreMinerals];

const plantShake = [
  amino("Pea Protein"),
  amino("L-Leucine"),
  amino("Organic Chia Seed Protein", "Chia Seed Protein"),
  amino("Organic Pumpkin Seed Protein", "Pumpkin Seed Protein"),
  fiber("Soluble Corn Fiber"),
  other("Organic Ancient Grains Blend"),
  lipid("MCT Oil", "Medium-Chain Triglycerides"),
  lipid("Milled Golden Flaxseed", "Flaxseed"),
  enzyme("Papain"),
  enzyme("Bromelain"),
];

const soyShake = [
  amino("Soy Protein Isolate", "Soy Protein"),
  amino("L-Leucine"),
  fiber("Soluble Corn Fiber"),
  other("Organic Ancient Grains Blend"),
  lipid("MCT Oil", "Medium-Chain Triglycerides"),
  lipid("Milled Golden Flaxseed", "Flaxseed"),
  enzyme("Papain"),
  enzyme("Bromelain"),
];

const fishOmega = [
  lipid("Fish Oil"),
  lipid("Omega-3 Fatty Acids"),
  lipid("EPA", "Eicosapentaenoic Acid"),
  lipid("DHA", "Docosahexaenoic Acid"),
];

const vivix = [
  botanical("Muscadine Grape Extract", "Muscadine Grape"),
  antioxidant("Trans-Resveratrol", "Resveratrol"),
  botanical("Red Wine Extract", "Red Wine"),
  botanical("Pomegranate Extract", "Pomegranate"),
  botanical("Chebulic Myrobalan Extract", "Chebulic Myrobalan"),
  botanical("Purple Carrot Extract", "Purple Carrot"),
  botanical("Black Currant Extract", "Black Currant"),
];

const liquidBioCell = [
  amino("Hydrolyzed Collagen Type II Peptides", "Collagen Type II", "Hydrolyzed"),
  other("Chondroitin Sulfate"),
  other("Hyaluronic Acid"),
];

const energizingTea = [
  amino("Taurine"),
  botanical("Rooibos Red Tea Extract", "Rooibos"),
  botanical("Green Tea Extract", "Green Tea"),
  botanical("White Tea Extract", "White Tea"),
  botanical("Matcha Green Tea Powder", "Matcha Green Tea", "Powder"),
];

const wheyAmino = [
  amino("Whey Protein", "Whey Protein"),
  amino("L-Leucine"),
  amino("L-Isoleucine"),
  amino("L-Valine"),
  amino("L-Lysine"),
  amino("L-Arginine"),
  amino("L-Glutamine"),
  amino("Taurine"),
];

const electrolyte = [
  mineral("Sodium"),
  mineral("Potassium"),
  mineral("Chloride"),
  mineral("Potassium Nitrate", "Potassium", "Nitrate"),
];

const trim = [
  lipid("Conjugated Linoleic Acid", "Linoleic Acid", "Conjugated"),
  ...liquidBioCell,
];

const trimSmooth = [
  ...trim,
  botanical("Melon Fruit Juice Concentrate", "Melon Fruit"),
];

const falseFactsImageIds = new Set([
  5, 7, 16, 17, 18, 20, 27, 38, 39, 41, 46, 68, 69, 74, 78, 79,
  91, 93, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108,
]);

const reviewedIngredients = new Map([
  [1, [
    ...broadMulti,
    ...fishOmega,
    probiotic("Probiotic Blend"),
    amino("N-Acetylcysteine", "Cysteine", "N-Acetyl"),
    antioxidant("Coenzyme Q10"),
  ]],
  [2, plantShake],
  [3, [
    fiber("Inulin"),
    probiotic("Bifidobacterium lactis HN019"),
    probiotic("Lactobacillus rhamnosus GG"),
    probiotic("Lacticaseibacillus paracasei Lpc-37"),
  ]],
  [4, electrolyte],
  [6, electrolyte],
  [8, electrolyte],
  [9, electrolyte],
  [10, [...coreVitamins, mineral("Calcium"), mineral("Iodine"), mineral("Magnesium"), mineral("Zinc"), mineral("Copper"), other("Choline")]],
  [11, [
    mineral("Chromium", "Chromium", "Picolinate"),
    fiber("Resistant Potato Starch"),
    fiber("Glucomannan", "Konjac Root"),
    antioxidant("Lemon Bioflavonoids Complex", "Lemon Bioflavonoids"),
    antioxidant("Eriocitrin"),
    botanical("Green Olive Leaf Extract", "Olive Leaf"),
    botanical("Grape Seed Extract", "Grape Seed"),
    botanical("Pomegranate Fruit Extract", "Pomegranate Fruit"),
    botanical("Green Tea Leaf Extract", "Green Tea Leaf"),
    botanical("Bilberry Fruit Extract", "Bilberry Fruit"),
    antioxidant("Citrus Hesperidin", "Hesperidin"),
  ]],
  [12, [
    vitamin("Vitamin C"),
    botanical("Ashwagandha Root Extract", "Ashwagandha Root"),
    botanical("Acerola Fruit Extract", "Acerola Fruit"),
    botanical("Orange Fruit and Peel Extract", "Orange Fruit and Peel"),
    antioxidant("Citrus Bioflavonoids"),
    antioxidant("Quercetin"),
    antioxidant("Rutin"),
    botanical("Schisandra Fruit Extract", "Schisandra Fruit"),
    botanical("American Ginseng Root Extract", "American Ginseng Root"),
  ]],
  [13, [
    enzyme("Amylase"),
    enzyme("Protease 4.5", "Protease"),
    enzyme("Bromelain"),
    enzyme("Cellulase"),
    enzyme("Protease 6.0", "Protease"),
    enzyme("Lipase"),
    enzyme("Lactase"),
    botanical("Fennel Seed"),
    botanical("Aloe Vera Inner Leaf Gel", "Aloe Vera Inner Leaf"),
    botanical("Ginger Root Extract", "Ginger Root"),
  ]],
  [14, [
    botanical("Coffee Bean"),
    botanical("Bacopa Leaf Extract", "Bacopa Leaf"),
    ...liquidBioCell,
    amino("L-Theanine"),
    botanical("Coffee Fruit Extract", "Coffee Fruit"),
    lipid("MCTs", "Medium-Chain Triglycerides"),
    botanical("Green Tea Leaf Extract", "Green Tea Leaf"),
    other("Caffeine"),
  ]],
  [15, [...coreVitamins.filter((item) => item.name !== "Vitamin K"), mineral("Iodine"), mineral("Zinc")]],
  [19, plantShake],
  [21, fishOmega],
  [22, [
    probiotic("Bifidobacterium lactis HN019"),
    probiotic("Lactiplantibacillus plantarum Lp-115"),
    probiotic("Lactobacillus acidophilus La-14"),
    probiotic("Lactobacillus rhamnosus GG"),
  ]],
  [23, [...coreVitamins, mineral("Calcium"), mineral("Iron"), mineral("Iodine"), mineral("Magnesium"), mineral("Zinc"), mineral("Copper")]],
  [24, [vitamin("Vitamin D3", "Vitamin D", "Cholecalciferol"), mineral("Calcium"), mineral("Magnesium")]],
  [25, [vitamin("Vitamin C"), vitamin("Vitamin D3", "Vitamin D", "Cholecalciferol"), mineral("Zinc"), botanical("Elderberry Extract", "Elderberry")]],
  [26, [vitamin("Vitamin C"), vitamin("Vitamin D3", "Vitamin D", "Cholecalciferol"), mineral("Zinc"), botanical("Elderberry Extract", "Elderberry")]],
  [28, [
    vitamin("Vitamin D"),
    vitamin("Vitamin K"),
    mineral("Calcium"),
    mineral("Magnesium"),
    mineral("Zinc"),
    mineral("Copper"),
    mineral("Manganese"),
  ]],
  [29, [
    vitamin("Vitamin C"),
    botanical("Rose Hips"),
    antioxidant("Grapefruit Bioflavonoid", "Grapefruit Bioflavonoid"),
    antioxidant("Hesperidin Complex", "Hesperidin"),
    antioxidant("Lemon Bioflavonoid"),
    antioxidant("Orange Bioflavonoid"),
  ]],
  [30, [vitamin("Vitamin C")]],
  [31, [
    botanical("Garlic Powder", "Garlic", "Powder"),
    botanical("Spearmint Oil", "Spearmint", "Oil"),
    botanical("Rosemary Extract", "Rosemary"),
  ]],
  [32, vivix],
  [33, [
    vitamin("Biotin"),
    mineral("Zinc"),
    mineral("Boron"),
    ...liquidBioCell,
    other("Calcium Fructoborate"),
    botanical("Fucoidan", "Wakame"),
    botanical("Masson Pine Bark Extract", "Masson Pine Bark"),
  ]],
  [34, [amino("Whey Protein"), amino("L-Leucine")]],
  [35, vivix],
  [36, [
    ...liquidBioCell,
    botanical("Mangosteen Fruit"),
    botanical("Blueberry Fruit Juice Concentrate", "Blueberry Fruit"),
    botanical("Acai Berry Extract", "Acai Berry"),
    botanical("Wolfberry Fruit Extract", "Wolfberry Fruit"),
    botanical("Pomegranate Fruit Juice Concentrate", "Pomegranate Fruit"),
    botanical("Noni Fruit"),
    botanical("Maqui Berry"),
    antioxidant("Resveratrol", "Japanese Knotweed Root Extract"),
  ]],
  [37, [
    vitamin("Vitamin C"),
    vitamin("Vitamin D3", "Vitamin D", "Cholecalciferol"),
    mineral("Zinc"),
    fiber("Beta-1,3/1,6-D-Glucan", "Beta-Glucan"),
    mushroom("Reishi Mushroom Extract", "Reishi Mushroom"),
    botanical("American Ginseng Root Extract", "American Ginseng Root"),
    botanical("Elderberry Extract", "Elderberry"),
    botanical("Echinacea Extract", "Echinacea"),
    antioxidant("Quercetin"),
    antioxidant("Hesperidin Complex", "Hesperidin"),
  ]],
  [40, energizingTea],
  [42, [
    vitamin("Vitamin C"),
    vitamin("Vitamin B6"),
    vitamin("Vitamin B12"),
    mineral("Zinc"),
    mineral("Selenium"),
  ]],
  [43, [
    vitamin("Vitamin E"),
    lipid("Gamma-Linolenic Acid", "Gamma-Linolenic Acid"),
    lipid("Linoleic Acid"),
    lipid("Borage Seed Oil", "Borage Seed", "Oil"),
  ]],
  [44, [
    mineral("Zinc"),
    botanical("Echinacea Extract", "Echinacea"),
    botanical("Larch Tree Extract", "Larch Tree"),
    botanical("Elderberry Extract", "Elderberry"),
    botanical("Stevia Leaf"),
  ]],
  [45, [
    vitamin("Vitamin C"),
    mineral("Chromium"),
    mushroom("Cordyceps Mycelium", "Cordyceps"),
    botanical("Berberine", "Indian Barberry Root Extract"),
    other("Caffeine"),
    botanical("Kelp Extract", "Kelp"),
    antioxidant("Theobromine"),
    botanical("Olive Fruit Extract", "Olive Fruit"),
    botanical("Green Tea Leaf Extract", "Green Tea Leaf"),
    botanical("Guarana Seed Extract", "Guarana Seed"),
    botanical("Green Coffee Bean Extract", "Green Coffee Bean"),
    botanical("Ginger Root"),
  ]],
  [47, [
    probiotic("Bifidobacterium longum"),
    probiotic("Lactobacillus acidophilus"),
  ]],
  [48, energizingTea],
  [49, energizingTea],
  [50, energizingTea],
  [51, plantShake],
  [52, trim],
  [53, trimSmooth],
  [54, [amino("Protein"), amino("L-Leucine"), fiber("Dietary Fiber")]],
  [55, [amino("Protein"), amino("L-Leucine"), fiber("Dietary Fiber")]],
  [56, [amino("Protein"), amino("L-Leucine"), fiber("Dietary Fiber")]],
  [57, [
    mineral("Magnesium", "Magnesium", "Citrate"),
    amino("Creatine Monohydrate", "Creatine", "Monohydrate"),
    botanical("Muscadine Grape Extract", "Muscadine Grape"),
    botanical("Pomegranate Extract", "Pomegranate"),
  ]],
  [58, [amino("Soy Protein Isolate", "Soy Protein"), amino("L-Leucine")]],
  [59, soyShake],
  [60, soyShake],
  [61, vivix],
  [62, [
    mineral("Magnesium"),
    mineral("Zinc"),
    mineral("Chromium"),
    amino("Taurine"),
    mineral("Vanadium"),
    antioxidant("Alpha-Lipoic Acid"),
    botanical("Banaba Leaf Extract", "Banaba Leaf"),
  ]],
  [63, [
    vitamin("Vitamin C"),
    mineral("Zinc"),
    mineral("Copper"),
    mineral("Manganese"),
    amino("Glucosamine Hydrochloride", "Glucosamine", "Hydrochloride"),
    botanical("Boswellia Extract", "Boswellia"),
  ]],
  [64, [
    mineral("Calcium"),
    mineral("Phosphorus"),
    botanical("Boswellia Extract", "Boswellia"),
    botanical("Safflower Extract", "Safflower"),
  ]],
  [65, [
    botanical("Milk Thistle Extract", "Milk Thistle"),
    botanical("Schisandra Extract", "Schisandra"),
    botanical("Dandelion Extract", "Dandelion"),
    mushroom("Reishi Mushroom Extract", "Reishi Mushroom"),
    botanical("Turmeric Extract", "Turmeric"),
    botanical("Artichoke Extract", "Artichoke"),
  ]],
  [66, [
    fiber("Inulin"),
    probiotic("Fructooligosaccharides", "FOS"),
    antioxidant("Mixed Tocopherols"),
  ]],
  [67, [
    botanical("Senna Leaf Powder", "Senna Leaf", "Powder"),
    botanical("Licorice Root Powder", "Licorice Root", "Powder"),
    botanical("Buckthorn Bark Powder", "Buckthorn Bark", "Powder"),
    botanical("Alfalfa Leaf Powder", "Alfalfa Leaf", "Powder"),
    botanical("Fennel Seed Powder", "Fennel Seed", "Powder"),
    botanical("Anise Seed Powder", "Anise Seed", "Powder"),
    botanical("Rhubarb Root Powder", "Rhubarb Root", "Powder"),
  ]],
  [70, [
    botanical("Organic Kale", "Kale"),
    botanical("Organic Spinach", "Spinach"),
    botanical("Organic Broccoli", "Broccoli"),
  ]],
  [71, [mineral("Calcium"), mineral("Phosphorus"), botanical("Alfalfa Leaf Powder", "Alfalfa Leaf", "Powder")]],
  [72, [mineral("Calcium"), mineral("Phosphorus"), botanical("Alfalfa Leaf Powder", "Alfalfa Leaf", "Powder")]],
  [73, [
    antioxidant("Coenzyme Q10"),
    antioxidant("Mixed Tocopherols"),
    antioxidant("Trans-Resveratrol", "Resveratrol"),
  ]],
  [75, [
    mineral("Calcium"),
    mineral("Phosphorus"),
    mineral("Zinc"),
    mineral("Copper"),
    botanical("Pumpkinseed Extract", "Pumpkin Seed"),
    botanical("Safflower Flower Extract", "Safflower Flower"),
    botanical("Asian Plantain Seed Extract", "Asian Plantain Seed"),
    botanical("Japanese Honeysuckle Flower Extract", "Japanese Honeysuckle Flower"),
  ]],
  [76, [
    ...broadMulti,
    ...fishOmega,
    probiotic("Probiotic Blend"),
    antioxidant("Lycopene"),
    antioxidant("Lutein"),
    antioxidant("Zeaxanthin"),
    antioxidant("Coenzyme Q10"),
  ]],
  [77, [
    amino("L-Theanine"),
    botanical("Ashwagandha Root Extract", "Ashwagandha Root"),
    other("Beta-Sitosterol"),
    amino("L-Tyrosine"),
  ]],
  [80, [
    vitamin("Vitamin B6"),
    vitamin("Folate", "Vitamin B9"),
    vitamin("Vitamin B12"),
    mineral("Calcium"),
    botanical("Chardonnay Grape Seed Extract", "Chardonnay Grape Seed"),
    botanical("Guarana Seed Extract", "Guarana Seed"),
    botanical("Blueberry Fruit Powder", "Blueberry Fruit", "Powder"),
    botanical("Green Coffee Bean Extract", "Green Coffee Bean"),
  ]],
  [81, [
    lipid("Algal Oil Concentrate", "Algal Oil"),
    lipid("DHA", "Docosahexaenoic Acid"),
    lipid("EPA", "Eicosapentaenoic Acid"),
  ]],
  [82, fishOmega],
  [83, [
    ...broadMulti,
    ...fishOmega,
    antioxidant("Resveratrol"),
    antioxidant("Lutein"),
    antioxidant("Zeaxanthin"),
    antioxidant("Coenzyme Q10"),
    amino("N-Acetylcysteine", "Cysteine", "N-Acetyl"),
  ]],
  [84, [
    other("Melatonin"),
    botanical("Valerian Root"),
    botanical("Lemon Balm"),
    amino("L-Theanine"),
  ]],
  [85, [
    botanical("Turmeric Root Extract", "Turmeric Root"),
    botanical("Black Pepper Fruit Extract", "Black Pepper Fruit"),
  ]],
  [86, [
    amino("Protein"),
    ...coreVitamins.slice(1),
    ...coreMinerals.slice(0, 10),
  ]],
  [87, [
    botanical("Tart Cherry Extract", "Tart Cherry"),
    botanical("Boswellia Extract", "Boswellia"),
    botanical("Safflower Extract", "Safflower"),
  ]],
  [88, wheyAmino],
  [89, plantShake],
  [90, plantShake],
  [92, [amino("Soy Protein Isolate", "Soy Protein"), ...coreVitamins.filter((item) => ["Thiamin", "Riboflavin", "Niacin", "Vitamin B6", "Pantothenic Acid"].includes(item.name))]],
  [94, [amino("Soy Protein Isolate", "Soy Protein"), ...coreVitamins.filter((item) => ["Thiamin", "Riboflavin", "Niacin", "Vitamin B6", "Pantothenic Acid"].includes(item.name))]],
  [95, soyShake],
  [96, wheyAmino],
  [97, [
    amino("Whey Protein Isolate", "Whey Protein"),
    amino("Milk Protein Isolate", "Milk Protein"),
    amino("Soy Protein Isolate", "Soy Protein"),
    amino("L-Leucine"),
  ]],
  [98, [amino("Soy Protein Isolate", "Soy Protein"), amino("L-Leucine")]],
  [109, [
    ...liquidBioCell,
    botanical("Germinated Pea Seed Extract", "Pea Seed"),
    botanical("Green Tea Leaf Extract", "Green Tea Leaf"),
    botanical("Bamboo Stem and Leaf Extract", "Bamboo Stem and Leaf"),
    botanical("Grape Seed Extract", "Grape Seed"),
    botanical("Pomegranate Extract", "Pomegranate"),
    botanical("Acai Berry Extract", "Acai Berry"),
  ]],
  [110, [amino("Hydrolyzed Chicken Collagen", "Chicken Collagen", "Hydrolyzed")]],
  [111, trimSmooth],
  [112, trimSmooth],
  [113, [
    amino("L-Glutamine"),
    amino("L-Leucine"),
    amino("L-Isoleucine"),
    amino("L-Valine"),
    amino("L-Arginine"),
    other("Betaine Hydrochloride", "Betaine", "Hydrochloride"),
    amino("Taurine"),
  ]],
  [114, [
    botanical("Sage Aerial Parts Extract", "Sage Aerial Parts"),
    botanical("Angelica gigas Nakai Root Extract", "Angelica gigas Nakai Root"),
    botanical("Cynanchum wilfordii Root Extract", "Cynanchum wilfordii Root"),
    botanical("Phlomis umbrosa Root Extract", "Phlomis umbrosa Root"),
    botanical("Olive Fruit Extract", "Olive Fruit"),
  ]],
  [115, [
    fiber("Psyllium Seed Husk", "Psyllium Seed"),
    fiber("Apple Fruit Pectin", "Apple Pectin"),
    botanical("Turkey Rhubarb Root"),
    botanical("Milk Thistle Seed Extract", "Milk Thistle Seed"),
    other("Sodium Copper Chlorophyllin"),
    botanical("Ginger Rhizome Extract", "Ginger Rhizome"),
    botanical("Aloe Vera Inner Leaf"),
    botanical("Dandelion Root Extract", "Dandelion Root"),
  ]],
  [116, [
    ...coreVitamins.filter((item) => item.name !== "Vitamin D" && item.name !== "Vitamin K"),
    other("Choline"),
    ...coreMinerals.filter((item) => item.name !== "Potassium"),
    mineral("Vanadium"),
  ]],
  [117, [
    vitamin("Vitamin A", "Vitamin A", "Beta-Carotene"),
    vitamin("Vitamin C", "Vitamin C", "Calcium Ascorbate"),
    vitamin("Vitamin E", "Vitamin E", "D-Alpha Tocopheryl Acetate"),
    botanical("Grape Seed Extract", "Grape Seed"),
    botanical("Turmeric Root Extract", "Turmeric Root"),
    botanical("Ginkgo Leaf Extract", "Ginkgo Leaf"),
    botanical("Maritime Pine Bark Extract", "Maritime Pine Bark"),
  ]],
]);

function imageUrl(item) {
  return String(item?.image_url ?? item?.imageUrl ?? item?.url ?? "");
}

function dedupeIngredients(items) {
  const byName = new Map();
  for (const item of items) {
    const name = typeof item === "string" ? item : item?.name ?? item?.value;
    if (!name) continue;
    const key = String(name).toLocaleLowerCase();
    const current = byName.get(key);
    if (
      current == null
      || (typeof current === "string" && typeof item === "object")
      || (
        typeof current === "object"
        && typeof item === "object"
        && Object.keys(item).length > Object.keys(current).length
      )
    ) {
      byName.set(key, item);
    }
  }
  return [...byName.values()];
}

function mergeSemanticIngredients(record, semanticItems) {
  const previous = Array.isArray(record.semantic_inference?.main_ingredients)
    ? record.semantic_inference.main_ingredients
    : [];
  const merged = dedupeIngredients([...previous, ...semanticItems].map((item) => ({
    ...item,
    name: item.name ?? item.value,
  }))).map(({ name, ...item }) => ({
    ...item,
    value: item.value ?? name,
  }));
  record.semantic_inference = {
    ...(record.semantic_inference ?? {}),
    main_ingredients: merged,
  };
}

const records = JSON.parse(await fs.readFile(inputPath, "utf8"));
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const decisions = [];
const recordReviewMap = new Map();

const missingDecisions = manifest
  .map((job) => Number(job.id))
  .filter((id) => !falseFactsImageIds.has(id) && !reviewedIngredients.has(id));
if (missingDecisions.length > 0) {
  throw new Error(`Missing visual decisions for image IDs: ${missingDecisions.join(", ")}`);
}

for (const job of manifest) {
  const id = Number(job.id);
  const screenshot = path.join(reviewRoot, "screenshots", `${String(id).padStart(3, "0")}.png`);
  const products = Array.isArray(job.products) ? job.products : [];
  if (falseFactsImageIds.has(id)) {
    for (const product of products) {
      const record = records[product.index];
      record.facts_images = (record.facts_images ?? []).filter(
        (item) => imageUrl(item) !== job.url,
      );
    }
    decisions.push({
      id,
      decision: "not_facts_image",
      reason: "Visual review found no supported Facts heading or a readable supported Facts panel.",
      image_url: job.url,
      screenshot,
      products,
    });
    continue;
  }

  const ingredients = reviewedIngredients.get(id);
  for (const product of products) {
    const record = records[product.index];
    const factsImage = (record.facts_images ?? []).find(
      (item) => imageUrl(item) === job.url,
    );
    if (!factsImage) {
      throw new Error(`Record ${product.index} is missing Facts image ${id}`);
    }
    const reviewed = finalizeFactsIngredientReview(factsImage, {
      reviewedVisually: true,
      visibleHeading: factsImage.type ?? job.factsType,
      ingredients,
    });
    const current = recordReviewMap.get(product.index) ?? {
      ingredients: [],
      semanticItems: [],
      imageReviews: [],
    };
    current.ingredients.push(...reviewed.fields.main_ingredients);
    current.semanticItems.push(...reviewed.meta.semanticInferences.main_ingredients);
    current.imageReviews.push({
      image_id: id,
      screenshot,
      ...reviewed.meta.factsIngredientReview,
    });
    recordReviewMap.set(product.index, current);
  }

  decisions.push({
    id,
    decision: "confirmed_facts_image",
    facts_type: job.factsType,
    visible_heading: job.factsType,
    image_url: job.url,
    screenshot,
    products,
    ingredients: ingredients.map(({ visibleText, ...item }) => item),
  });
}

for (const [index, review] of recordReviewMap) {
  const record = records[index];
  record.main_ingredients = dedupeIngredients([
    ...(record.main_ingredients ?? []),
    ...review.ingredients,
  ]);
  mergeSemanticIngredients(record, review.semanticItems);
  record.facts_image_reviews = review.imageReviews;
  record.facts_ingredient_review = {
    status: "visual_complete",
    result: record.main_ingredients.length > 0
      ? "ingredients_read"
      : "no_main_ingredients_visible",
    image_url: review.imageReviews[0]?.image_url,
    facts_type: review.imageReviews[0]?.facts_type,
    visible_heading: review.imageReviews[0]?.visible_heading,
    ingredient_count: record.main_ingredients.length,
    images_reviewed: review.imageReviews.length,
  };
}

const unresolvedFacts = records.flatMap((record, index) => {
  if ((record.facts_images ?? []).length === 0) return [];
  return record.facts_ingredient_review?.status === "visual_complete"
    ? []
    : [{ index, title: record.title, facts_images: record.facts_images.length }];
});
if (unresolvedFacts.length > 0) {
  throw new Error(`Unresolved Facts reviews: ${JSON.stringify(unresolvedFacts)}`);
}

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  path.join(outputDir, "facts-image-decisions.json"),
  `${JSON.stringify(decisions, null, 2)}\n`,
);

const exportResult = await writeEnrichProductExport(outputDir, records, {
  domain: "shaklee.com",
  updateExisting: false,
  requireFactsIngredientReview: true,
});

const summary = {
  ...exportResult.summary,
  visuallyReviewedImages: manifest.length,
  confirmedFactsImages: decisions.filter((item) => item.decision === "confirmed_facts_image").length,
  rejectedFactsCandidates: decisions.filter((item) => item.decision === "not_facts_image").length,
  productsWithMainIngredients: records.filter((record) => (record.main_ingredients ?? []).length > 0).length,
  totalMainIngredientLinks: records.reduce(
    (sum, record) => sum + (record.main_ingredients ?? []).length,
    0,
  ),
};
await fs.writeFile(
  path.join(outputDir, "reprocess-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);

console.log(JSON.stringify(summary, null, 2));
