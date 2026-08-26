import fs from "node:fs/promises";
import path from "node:path";

const OUTPUT_DIR = path.resolve("output/shaklee-all");
const PRODUCTS_PATH = path.join(OUTPUT_DIR, "products.json");
const CHECKPOINT_PATH = path.join(OUTPUT_DIR, "enrichment-checkpoint.json");
const REPORT_PATH = path.join(OUTPUT_DIR, "crawl-report.json");
const MANIFEST_PATH = path.join(OUTPUT_DIR, "facts-visual-review", "manifest.json");

const CONFIRMED_VISUAL_FACTS = new Set([
  3, 5, 55, 56, 57, 58, 59, 60, 61, 62,
  63, 64, 65, 66, 67, 68, 69, 71, 72, 82,
]);

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const excerpt = (value, max = 300) => clean(value).slice(0, max);

function productIdFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.match(/\/p\/([^/]+)$/)?.[1] ?? "");
  } catch {
    return "";
  }
}

function assetKey(rawUrl) {
  try {
    let basename = decodeURIComponent(new URL(rawUrl).pathname)
      .split("/")
      .pop()
      .toLowerCase();
    basename = basename
      .replace(/shkconversionmediaformat\d+x\d+-?/g, "")
      .replace(/-shkconversionmediaformat\d+x\d+/g, "")
      .replace(/^-?1200wx1200h-/, "")
      .replace(/^-+|-+$/g, "")
      .replace(/-1200$/, "")
      .replace(/\.(?:png|jpe?g|webp|gif)$/i, "")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "");
    const segments = basename.split("-");
    return segments
      .map((segment, index) =>
        index > 0 && /^\d+$/.test(segment) ? String(Number(segment)) : segment)
      .join("-");
  } catch {
    return clean(rawUrl).toLowerCase();
  }
}

function assetName(rawUrl) {
  try {
    return decodeURIComponent(new URL(rawUrl).pathname.split("/").pop() ?? "")
      .replace(/^shkconversionMediaFormat\d+x\d+-/i, "")
      .replace(/-shkconversionMediaFormat\d+x\d+/i, "")
      .toLowerCase();
  } catch {
    return null;
  }
}

function imageResolutionScore(url) {
  const dimensions = [...String(url).matchAll(/(\d+)x(\d+)/g)]
    .map((match) => Number(match[1]) * Number(match[2]))
    .sort((a, b) => b - a)[0] ?? 0;
  if (String(url).includes("160x160")) return dimensions - 1_000_000;
  if (String(url).includes("660x660")) return dimensions + 1_000_000;
  return dimensions + 500_000;
}

function dedupeHighResolutionImages(urls) {
  const bestByAsset = new Map();
  const order = [];
  for (const url of urls.filter(Boolean)) {
    const key = assetKey(url);
    if (!bestByAsset.has(key)) order.push(key);
    const current = bestByAsset.get(key);
    if (!current || imageResolutionScore(url) > imageResolutionScore(current)) {
      bestByAsset.set(key, url);
    }
  }
  return order.map((key) => bestByAsset.get(key));
}

function resolveHighResolutionImage(product, candidateUrl) {
  const key = assetKey(candidateUrl);
  const matches = [
    candidateUrl,
    ...(product.images ?? []).filter((url) => assetKey(url) === key),
  ].filter((url, index, all) => all.indexOf(url) === index);
  return matches.sort((a, b) => imageResolutionScore(b) - imageResolutionScore(a))[0];
}

function sentenceWith(text, pattern) {
  const sentences = clean(text).split(/(?<=[.!?*])\s+/);
  return excerpt(sentences.find((sentence) => pattern.test(sentence)) ?? text);
}

function inferenceItem(value, evidence, {
  basis = "inferred",
  confidence = "high",
  rationale,
} = {}) {
  return {
    value,
    basis,
    confidence,
    evidence: [evidence],
    ...(basis === "inferred"
      ? { rationale: rationale ?? `The product description supports the normalized “${value}” classification.` }
      : {}),
  };
}

function inferForm(product) {
  const title = clean(product.title);
  const description = clean(product.description);
  const categories = product.categories ?? [];
  const titleLower = title.toLowerCase();
  const text = `${title} ${description}`.toLowerCase();
  const isHome = categories.includes("Green Home");
  const isBeauty = categories.includes("Beauty");
  const titleEvidence = { source: "product.title", excerpt: title };
  const descriptionEvidence = { source: "product.description", excerpt: description };

  const explicit = (value, presentation = null) => ({
    form: inferenceItem(value, titleEvidence, { basis: "explicit", confidence: "high" }),
    presentation,
  });
  const described = (value, pattern, presentation = null, confidence = "high") => ({
    form: inferenceItem(value, {
      source: "product.description",
      excerpt: sentenceWith(description, pattern),
    }, { basis: "explicit", confidence }),
    presentation,
  });
  const inferred = (value, presentation = null, rationale, confidence = "medium") => ({
    form: inferenceItem(value, descriptionEvidence, { basis: "inferred", confidence, rationale }),
    presentation,
  });

  if (isHome) {
    if (/collection/.test(titleLower)) return explicit("household cleaning kit", "kit");
    if (/dryer sheets?/.test(titleLower)) return explicit("dryer sheet", "box");
    if (/cleaning cloth/.test(titleLower)) return explicit("cleaning cloth", "standalone accessory");
    if (/measuring spoons?/.test(titleLower)) return explicit("measuring spoon", "accessory pack");
    if (/measuring cup/.test(titleLower)) return explicit("measuring cup", "standalone accessory");
    if (/pump dispenser|dispenser/.test(titleLower)) return explicit("pump dispenser", "standalone accessory");
    if (/powder/.test(titleLower)) return explicit("powder concentrate");
    if (/liquid concentrate|concentrate \(liquid\)/.test(titleLower)) return explicit("liquid concentrate");
    if (/concentrate/.test(titleLower)) return explicit("concentrated cleaner");
    if (/scour off/.test(titleLower)) return inferred(
      "cleaning paste",
      null,
      "The product is a household scouring cleaner; the normalized form describes its paste-like cleaning format.",
    );
    return inferred(
      "liquid cleaner",
      null,
      "The Green Home category and description identify a household cleaner; no more specific physical format is stated.",
    );
  }

  if (/cosmetics wedge/.test(titleLower)) return explicit("cosmetic sponge", "standalone applicator");
  if (/spatula/.test(titleLower)) return explicit("cosmetic spatula", "standalone applicator");
  if (/sculpting wand|smoothing wand/.test(titleLower)) return explicit("skincare device", "handheld wand");
  if (/cleansing bars?/.test(titleLower)) return explicit("cleansing bar", /bundle|pack/.test(titleLower) ? "multipack" : null);
  if (/bb cream/.test(titleLower)) return explicit("tinted cream");
  if (/pain cream|multi-purpose cream|shea butter cream|hand cream|day cream|night cream/.test(titleLower)) {
    return explicit("topical cream");
  }
  if (/moisturizer/.test(titleLower)) return explicit("topical moisturizer");
  if (/lip serum/.test(titleLower)) return explicit("lip serum");
  if (/serum/.test(titleLower)) return explicit("topical serum");
  if (/lip oil/.test(titleLower)) return explicit("lip oil");
  if (/gel oil cleanser/.test(titleLower)) return explicit("gel-to-oil cleanser");
  if (/facial cleanser|beard wash|body wash|shampoo/.test(titleLower)) return explicit("liquid cleanser");
  if (/conditioner/.test(titleLower)) return explicit("hair conditioner");
  if (/toner/.test(titleLower)) return explicit("liquid toner");
  if (/body lotion/.test(titleLower)) return explicit("body lotion");
  if (/deodorant/.test(titleLower)) return explicit("solid deodorant", "stick");
  if (/body exfoliant|facial exfoliant|exfoliant/.test(titleLower)) return explicit("topical exfoliant");
  if (/body butter/.test(titleLower)) return explicit("body butter");
  if (/firming foam|tanning foam/.test(titleLower)) return explicit("topical foam", "pump bottle");
  if (/mascara/.test(titleLower)) return explicit("liquid mascara", "wand applicator");
  if (/salve/.test(titleLower)) return explicit("topical salve");
  if (/scalp treatment/.test(titleLower)) return explicit("scalp treatment");

  if (/liquid biocell/.test(titleLower)) {
    return explicit("liquid supplement", /2 pack/.test(titleLower) ? "two-bottle pack" : "bottle");
  }
  if (/joint & muscle pain cream/.test(titleLower)) return explicit("topical cream");
  if (/gummy|gummies|gellys/.test(text)) return explicit("gummy");
  if (/chewable|energy chews/.test(titleLower)) return explicit("chewable");
  if (/meal-in-a-bar|snack bar/.test(titleLower)) return explicit("nutrition bar", "individually wrapped bars");
  if (/\bcapsules?\b/.test(description)) return described("capsule", /\bcapsules?\b/);
  if (/\btablets?\b/.test(description)) return described("tablet", /\btablets?\b/);

  const formOverrides = {
    "34012": ["liquid supplement", "bottle"],
    "34016": ["liquid supplement", "bottle"],
    "34021": ["liquid supplement", "bottle"],
    "34023": ["liquid supplement", "bottle"],
    "34024": ["capsule", "bottle"],
    "34025": ["powder drink mix", "single-serve packets"],
    "34026": ["powder supplement", "canister"],
    "34033": ["capsule", "bottle"],
    "34034": ["powder drink mix", "single-serve packets"],
    "34040": ["capsule", "bottle"],
    "34041": ["capsule", "bottle"],
    "34043": ["powder drink mix", "single-serve packets"],
    "34055": ["capsule", "bottle"],
    "34085": ["tablet", "bottle"],
    "34109": ["tablet", "bottle"],
  };
  if (formOverrides[product.product_id]) {
    const [value, presentation] = formOverrides[product.product_id];
    return inferred(
      value,
      presentation,
      "The dosage form is inferred from the product’s directions/Facts presentation and its catalog context.",
      "high",
    );
  }

  if (/powder|drink mix/.test(description)) {
    return described(
      "powder drink mix",
      /powder|drink mix/,
      /\bpacket\b/.test(description) ? "single-serve packets" : null,
    );
  }
  if (/shake|smoothee|protein blend|whey protein|soy protein|collagen-9|creatine\+ power blend|physique.*bio-build|energizing tea|electrolyte.*drink|multiv drink|sparkling protein|greens booster|triple defense boost/.test(titleLower)) {
    return inferred(
      "powder drink mix",
      /\bpackets?\b/.test(description) ? "single-serve packets" : null,
      "The title and usage description identify a product prepared as a drink or shake.",
      "high",
    );
  }
  if (/drink elixir|mint tea|vanilla latte/.test(description)) {
    return inferred(
      "powder drink mix",
      /\bpacket\b/.test(description) ? "single-serve packets" : null,
      "The description identifies an oral product prepared and consumed as a flavored drink.",
      "high",
    );
  }
  if (/vivix/.test(titleLower)) return explicit("liquid supplement", "bottle");

  if (/bundle|stack|regimen|starter set|collection|trio|duo|system|family pack|wellness bundle|vitalizing plan|life plan|healthier life|five day|30 day|21 day|meology/.test(titleLower)) {
    return explicit("multi-product kit", "kit");
  }
  if (/7-day healthy cleanse/.test(titleLower)) return explicit("multi-day supplement kit", "packet kit");
  if (isBeauty) {
    return inferred(
      "personal care product",
      null,
      "The Beauty category and product description identify a topical or cosmetic personal-care item, but do not state a narrower physical format.",
    );
  }
  return inferred(
    "oral dietary supplement",
    null,
    "The product is sold in the nutrition/supplement catalog, while the supplied text does not state a narrower dosage form.",
  );
}

const HEALTH_RULES = [
  ["digestive health support", /digest|gut|probiotic|prebiotic|microbiome|regularity|lax|colon|enzyme|fiber/],
  ["immune system support", /immune|immunity|defend|resist|nutriferon/],
  ["energy and metabolism support", /energ|metaboli|thermogenic|uplift|fat oxidation/],
  ["healthy weight management support", /weight|appetite|satiety|carb blocker|craving|body fat|lean body|trim|sculpt|reset/],
  ["joint and mobility support", /joint|mobility|glucos|cartilage|collagen\/ha|connective tissue/],
  ["bone health support", /bone|cal mag|calcium|osteomatrix/],
  ["cardiovascular health support", /cardiovascular|heart|cholesterol|blood pressure|coq/],
  ["brain and cognitive support", /brain|cognitive|mental|focus|clarity|mindworks|logiq|acuity/],
  ["sleep and relaxation support", /sleep|restful|dream serene|bedtime routine/],
  ["stress and mood support", /stress|mood|calm|relax|ashwagandha|cheer up|chill out/],
  ["eye health support", /eye health|vision/],
  ["liver health support", /\bliver\b|\bdtx\b/],
  ["women’s health support", /women|prenatal|menopause|perimenopause|ova-m|vaginal|female health/],
  ["men’s health support", /\bmen\b|men’s|men's/],
  ["protein and muscle support", /protein|muscle|creatine|whey|bcaas?|lean body mass/],
  ["sports performance and recovery support", /performance|workout|endurance|recovery|physique|exercise|fitness/],
  ["hydration and electrolyte support", /hydrat|electrolyte/],
  ["antioxidant and cellular health support", /antioxidant|oxidative|free radicals|polyphenol|cellular|cell oxidation/],
  ["skin, hair, and nail support", /skin|hair|nail|collagen|hyaluronic acid/],
  ["cleanse and detox support", /cleanse|detox|dtx|toxins/],
  ["foundational nutrition support", /multivitamin|vitamins? and minerals?|essential nutrition|daily essentials|foundational wellness|overall wellness/],
  ["healthy glucose metabolism support", /glucose|blood sugar|insulin/],
  ["joint and muscle comfort support", /pain relief|joint & muscle pain|muscle comfort/],
  ["hormonal life-stage support", /menopause|perimenopause|post-menopause|hormone story/],
];

const BEAUTY_RULES = [
  ["sun protection", /\bspf\b|sunscreen|uva|uvb|sun protection/],
  ["skin hydration support", /moistur|hydrat|lotion|body butter|lip oil|lip serum/],
  ["visible anti-aging appearance support", /anti-aging|age def|ageless|wrinkle|firm|lift|fine lines|younger-looking|renewal/],
  ["skin cleansing support", /cleanser|cleansing|body wash|beard wash/],
  ["skin exfoliation support", /exfoliant|exfoliat/],
  ["skin radiance and tone support", /radiance|glow|bright|toner|bb cream|even skin tone/],
  ["eye-area appearance support", /eye treatment|smoothing wand for eyes|lash|mascara/],
  ["body skin care support", /body lotion|body serum|body butter|body exfoliant|body firming/],
  ["odor control", /deodorant/],
  ["hair and scalp care support", /hair|scalp|shampoo|conditioner/],
  ["cosmetic color and finish", /mascara|lip oil|bb cream|sunless tanning/],
  ["facial hair grooming support", /beard wash|grooming/],
  ["skin comfort support", /salve|sensitive|soothing/],
];

function inferHealthFunctions(product) {
  const title = clean(product.title);
  const description = clean(product.description);
  const categories = product.categories ?? [];
  const text = `${title} ${description}`.toLowerCase();
  const isHome = categories.includes("Green Home");
  const isPureCosmeticAccessory = /cosmetics wedge|spatula/.test(title.toLowerCase());

  if (isHome || isPureCosmeticAccessory) {
    return {
      values: [],
      items: [],
      status: {
        status: "not_applicable",
        evidence: [{
          source: isHome ? "product.categories" : "product.title",
          excerpt: isHome ? categories.join(" > ") : title,
        }],
        reason: isHome
          ? "Household cleaning products and their accessories do not have a consumer health-function field."
          : "A cosmetic applicator accessory does not itself have a health function.",
      },
    };
  }

  const rules = categories.includes("Beauty")
    ? [...BEAUTY_RULES, ...HEALTH_RULES]
    : HEALTH_RULES;
  const items = [];
  const seen = new Set();
  for (const [value, pattern] of rules) {
    if (!pattern.test(text) || seen.has(value)) continue;
    seen.add(value);
    items.push(inferenceItem(value, {
      source: "product.description",
      excerpt: sentenceWith(description, pattern),
    }, {
      basis: "inferred",
      confidence: "high",
      rationale: `The product description connects the product with ${value.replace(/ support$/, "")}.`,
    }));
  }

  if (product.product_id === "34010" && !seen.has("pet and equine wellness support")) {
    items.push(inferenceItem("pet and equine wellness support", {
      source: "product.description",
      excerpt: description,
    }, {
      basis: "inferred",
      confidence: "high",
      rationale: "The description explicitly identifies the intended users as pets and horses.",
    }));
  }

  if (items.length === 0) {
    const fallback = categories.includes("Beauty")
      ? "cosmetic appearance support"
      : "general wellness support";
    items.push(inferenceItem(fallback, {
      source: "product.description",
      excerpt: description,
    }, {
      basis: "inferred",
      confidence: "medium",
      rationale: categories.includes("Beauty")
        ? "The item is a beauty/personal-care product, but the supplied text does not support a narrower normalized function."
        : "The item is a nutrition or wellness product, but the supplied text does not support a narrower normalized function.",
    }));
  }

  return { values: items.map((item) => item.value), items, status: null };
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const products = await readJson(PRODUCTS_PATH);
const checkpoint = await readJson(CHECKPOINT_PATH);
const report = await readJson(REPORT_PATH);
const manifest = await readJson(MANIFEST_PATH);

const pageEvidenceById = new Map(
  Object.values(checkpoint.page_evidence ?? {}).map((item) => [
    productIdFromUrl(item.product_url),
    item,
  ]),
);
const visualReviewByUrl = new Map(
  manifest.map((item) => [
    item.url,
    {
      number: item.number,
      isFactsImage: CONFIRMED_VISUAL_FACTS.has(item.number),
      factsType: CONFIRMED_VISUAL_FACTS.has(item.number) ? "Supplement Facts" : null,
      visibleHeading: CONFIRMED_VISUAL_FACTS.has(item.number) ? "Supplement Facts" : null,
      evidence: CONFIRMED_VISUAL_FACTS.has(item.number)
        ? "Visible Supplement Facts heading"
        : "Visual review found no supported Facts heading",
      reviewed_at: new Date().toISOString(),
    },
  ]),
);

checkpoint.facts_reviews = Object.fromEntries(visualReviewByUrl);
checkpoint.facts_review_summary = {
  unique_candidates_reviewed: manifest.length,
  confirmed_facts_images: CONFIRMED_VISUAL_FACTS.size,
  rejected_marketing_or_ingredient_images: manifest.length - CONFIRMED_VISUAL_FACTS.size,
  supported_headings: ["Supplement Facts", "Nutrition Facts", "Drug Facts", "Product Facts"],
};

for (const product of products) {
  const page = pageEvidenceById.get(product.product_id);
  const candidates = page?.candidates ?? [];
  product.images = dedupeHighResolutionImages([
    ...(page?.gallery ?? []).map((image) => image.url),
    ...(product.images ?? []),
  ]);
  const facts = [];
  const seenFacts = new Set();

  const addFact = (candidate, classificationBasis, evidenceText, factsType) => {
    const highResolutionUrl = resolveHighResolutionImage(product, candidate.image.url);
    const key = `${factsType}|${assetKey(highResolutionUrl)}`;
    if (seenFacts.has(key)) return;
    seenFacts.add(key);
    if (!(product.images ?? []).includes(highResolutionUrl)) {
      product.images = [...(product.images ?? []), highResolutionUrl];
    }
    facts.push({
      type: factsType,
      alt: candidate.image.alt ?? null,
      image_url: highResolutionUrl,
      asset: assetName(highResolutionUrl),
      gallery_index: candidate.image.galleryIndex ?? null,
      classification_basis: classificationBasis,
      evidence: evidenceText,
    });
  };

  for (const candidate of candidates) {
    if (candidate.decision === "classified" && candidate.factsType) {
      addFact(
        candidate,
        "explicit_metadata",
        candidate.image.alt || candidate.image.title || candidate.factsType,
        candidate.factsType,
      );
      continue;
    }
    if (candidate.decision !== "visual_review") continue;
    const review = visualReviewByUrl.get(candidate.image.url);
    if (review?.isFactsImage) {
      addFact(candidate, "visual_content", review.visibleHeading, review.factsType);
    }
  }

  product.facts_images = facts;
  product.image_count = (product.images ?? []).length;

  if (product.product_id !== "34034") {
    const formResult = inferForm(product);
    product.form = formResult.form.value;
    product.form_presentation = formResult.presentation;
    product.semantic_inference = {
      ...(product.semantic_inference ?? {}),
      form: {
        ...formResult.form,
        ...(formResult.presentation ? { presentation: formResult.presentation } : {}),
      },
    };
  }

  if (product.product_id !== "34034") {
    const healthResult = inferHealthFunctions(product);
    product.health_function = healthResult.values;
    product.semantic_inference = {
      ...(product.semantic_inference ?? {}),
      ...(healthResult.items.length > 0 ? { health_function: healthResult.items } : {}),
      ...(healthResult.status ? { health_function_status: healthResult.status } : {}),
    };
  }
}

const factsRows = products.flatMap((product) =>
  (product.facts_images ?? []).map((facts) => ({
    product_id: product.product_id,
    title: product.title,
    facts_type: facts.type,
    alt: facts.alt,
    image_url: facts.image_url,
    asset: facts.asset,
    product_url: product.product_url,
    classification_basis: facts.classification_basis,
    evidence: facts.evidence,
  })),
);

const csvHeaders = [
  "product_id", "title", "retail_price", "currency", "description", "categories",
  "product_url", "availability", "form", "form_presentation", "health_function",
  "semantic_inference", "image_count", "images", "facts_types", "facts_image_urls",
];
const csvRows = products.map((product) => [
  product.product_id,
  product.title,
  product.retail_price,
  product.currency,
  product.description,
  (product.categories ?? []).join(" | "),
  product.product_url,
  product.availability,
  product.form,
  product.form_presentation,
  (product.health_function ?? []).join(" | "),
  JSON.stringify(product.semantic_inference ?? null),
  product.image_count,
  (product.images ?? []).join(" | "),
  (product.facts_images ?? []).map((item) => item.type).join(" | "),
  (product.facts_images ?? []).map((item) => item.image_url).join(" | "),
]);
const csv = `\uFEFF${[csvHeaders, ...csvRows]
  .map((row) => row.map(csvCell).join(","))
  .join("\n")}\n`;

const healthNotApplicable = products.filter(
  (product) => product.semantic_inference?.health_function_status?.status === "not_applicable",
).length;
const factsTypeCounts = Object.fromEntries(
  [...new Set(factsRows.map((row) => row.facts_type))]
    .sort()
    .map((type) => [type, factsRows.filter((row) => row.facts_type === type).length]),
);
report.generated_at = new Date().toISOString();
report.images = {
  ...report.images,
  total_product_images: products.reduce((sum, product) => sum + product.image_count, 0),
  products_with_facts_images: products.filter((product) => product.facts_images.length > 0).length,
  total_facts_images: factsRows.length,
  facts_type_counts: factsTypeCounts,
  facts_visual_review: {
    unique_candidates_reviewed: manifest.length,
    confirmed: CONFIRMED_VISUAL_FACTS.size,
    rejected: manifest.length - CONFIRMED_VISUAL_FACTS.size,
  },
  high_resolution_rule: "Facts candidates are matched back to the product gallery by logical asset identity; the largest available product-gallery URL is exported.",
  classification_rule: "Explicit Supplement/Nutrition/Drug/Product Facts metadata is classified directly. Ambiguous ingredients, label, generic facts, and secondary-gallery candidates are accepted only when visual review confirms a supported Facts heading.",
};
report.semantic_enrichment = {
  fields: ["form", "form_presentation", "health_function"],
  products_enriched: products.length,
  products_with_health_functions: products.filter((product) => product.health_function.length > 0).length,
  health_function_not_applicable: healthNotApplicable,
  missing_form: products.filter((product) => !product.form).length,
  missing_health_status: products.filter(
    (product) =>
      product.health_function.length === 0 &&
      product.semantic_inference?.health_function_status?.status !== "not_applicable",
  ).length,
  status: "complete",
  rule: "Derived fields preserve basis, confidence, rationale, and page evidence. Household products and pure accessories are explicitly marked not_applicable. Normalized values avoid unsupported treatment, cure, diagnosis, or prevention claims.",
};

await Promise.all([
  fs.writeFile(PRODUCTS_PATH, `${JSON.stringify(products, null, 2)}\n`),
  fs.writeFile(path.join(OUTPUT_DIR, "facts-images.json"), `${JSON.stringify(factsRows, null, 2)}\n`),
  fs.writeFile(path.join(OUTPUT_DIR, "products.csv"), csv),
  fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`),
  fs.writeFile(CHECKPOINT_PATH, `${JSON.stringify(checkpoint, null, 2)}\n`),
]);

console.log(JSON.stringify({
  products: products.length,
  facts_images: factsRows.length,
  products_with_facts_images: products.filter((product) => product.facts_images.length > 0).length,
  facts_type_counts: factsTypeCounts,
  products_with_health_functions: products.filter((product) => product.health_function.length > 0).length,
  health_function_not_applicable: healthNotApplicable,
  missing_form: products.filter((product) => !product.form).length,
  missing_health_status: products.filter(
    (product) =>
      product.health_function.length === 0 &&
      product.semantic_inference?.health_function_status?.status !== "not_applicable",
  ).length,
}, null, 2));
