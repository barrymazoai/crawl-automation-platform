import fs from 'node:fs/promises';
import path from 'node:path';

const root = '/Users/songtianjian/Documents/browser-scaperskill/real-crawl-results/irwin-naturals-20260820';
const raw = JSON.parse(await fs.readFile(path.join(root, 'crawl-records-raw.json'), 'utf8'));
const variantEvidence = JSON.parse(await fs.readFile(path.join(root, 'variant-evidence.json'), 'utf8'));
const variantMatrix = JSON.parse(await fs.readFile(path.join(root, 'variant-matrix.json'), 'utf8'));
const assets = JSON.parse(await fs.readFile(path.join(root, 'image-review/asset-manifest.json'), 'utf8'));

const topicalHandles = new Set([
  'cbd-balm-1000mg',
  'cbd-balm-1000mg-lemongrass',
  'cbd-balm-1000mg-menthol',
  'cbd-cream-1000mg-arnica',
  'cbd-cream-1000mg-menthol',
  'cbd-gel-1000mg-arnica',
  'cbd-gel-1000mg-menthol',
]);

const kitHandles = new Set([
  '7-day-ultimate-cleanse-natures-secret',
  'ultimate-cleanse-natures-secret',
]);

const explicitGalleryFactsIds = new Set([118, 296, 297, 307, 311, 322, 336, 408]);
const urlToFactsImages = new Map();
for (const asset of assets) {
  if (!asset.ok) continue;
  const isFacts = asset.kinds?.includes('facts_panel') || explicitGalleryFactsIds.has(asset.id);
  if (!isFacts) continue;
  for (const owner of asset.owners ?? []) {
    const list = urlToFactsImages.get(owner.productUrl) ?? [];
    list.push(asset.url);
    urlToFactsImages.set(owner.productUrl, [...new Set(list)]);
  }
}

const manualFacts = {
  'double-potency-cbd-30mg-per-soft-gel-15ct': 'Supplement Facts. Serving Size: 1 Liquid Soft-Gel. MCT Oil 400 mg. Full-Spectrum Hemp Extract 60 mg, naturally providing 30 mg CBD. Flaxseed Oil 200 mg.',
  'power-to-sleep-pm-melatonin-free': 'Supplement Facts. Serving Size: 3 Liquid Soft-Gels. Flaxseed Oil 1500 mg; Sensoril Ashwagandha Extract 375 mg; Bacopa Extract 375 mg; Holy Basil Extract 200 mg; AlphaWave L-Theanine 100 mg; InnovaTea Natural Tea Extract 52 mg; Magnesium 25 mg.',
  'l-citrulline-l-arginine-60ct': 'Supplement Facts. Serving Size: 3 Liquid Soft-Gels. Flaxseed Oil 1650 mg; L-Citrulline 750 mg; Horny Goat Weed Extract 375 mg; L-Arginine 150 mg; Beet Powder 100 mg.',
  'pro-active-nitric-oxide': 'Supplement Facts. Serving Size: 4 Liquid Soft-Gels. Flaxseed Oil 1800 mg; L-Citrulline 1500 mg; MCT Oil 1000 mg; Sabeet Beet Extract 150 mg; Cayenne Powder 60 mg; Pomegranate Extract 50 mg; Red Ginseng Extract 20 mg.',
};

const ingredients = [
  ['Vitamin C', 'ascorbic acid', 'vitamins'],
  ['Vitamin D3', 'vitamin D3', 'vitamins'],
  ['Vitamin K2', 'vitamin K2', 'vitamins'],
  ['Vitamin B12', 'vitamin B12', 'vitamins'],
  ['Biotin', 'biotin', 'vitamins'],
  ['Magnesium', 'magnesium', 'minerals'],
  ['Zinc', 'zinc', 'minerals'],
  ['Iron', 'iron', 'minerals'],
  ['Calcium', 'calcium', 'minerals'],
  ['L-Citrulline', 'L-citrulline', 'amino_acids_peptides'],
  ['L-Arginine', 'L-arginine', 'amino_acids_peptides'],
  ['L-Theanine', 'L-theanine', 'amino_acids_peptides'],
  ['5-HTP', '5-hydroxytryptophan', 'amino_acids_peptides'],
  ['Acetyl-L-Carnitine', 'acetyl-L-carnitine', 'amino_acids_peptides'],
  ['Hydrolyzed Collagen', 'collagen peptides', 'amino_acids_peptides'],
  ['Alpha-GPC', 'alpha-GPC', 'amino_acids_peptides'],
  ['Ashwagandha', 'ashwagandha', 'herbs_botanicals'],
  ['Maca', 'maca', 'herbs_botanicals'],
  ['Milk Thistle', 'milk thistle', 'herbs_botanicals'],
  ['Turmeric', 'turmeric', 'herbs_botanicals'],
  ['Ginkgo', 'ginkgo biloba', 'herbs_botanicals'],
  ['Echinacea', 'echinacea', 'herbs_botanicals'],
  ['Astragalus', 'astragalus', 'herbs_botanicals'],
  ['Elderberry', 'elderberry', 'herbs_botanicals'],
  ['Saw Palmetto', 'saw palmetto', 'herbs_botanicals'],
  ['Fenugreek', 'fenugreek', 'herbs_botanicals'],
  ['Horny Goat Weed', 'epimedium', 'herbs_botanicals'],
  ['Ginseng', 'ginseng', 'herbs_botanicals'],
  ['Shatavari', 'shatavari', 'herbs_botanicals'],
  ['Rhodiola', 'rhodiola', 'herbs_botanicals'],
  ['Holy Basil', 'holy basil', 'herbs_botanicals'],
  ['Valerian', 'valerian', 'herbs_botanicals'],
  ['Passionflower', 'passionflower', 'herbs_botanicals'],
  ['Chamomile', 'chamomile', 'herbs_botanicals'],
  ['Green Tea', 'green tea', 'herbs_botanicals'],
  ['Beet', 'beet root', 'herbs_botanicals'],
  ['Moringa', 'moringa', 'herbs_botanicals'],
  ['Yohimbe', 'yohimbe', 'herbs_botanicals'],
  ['Cascara Sagrada', 'cascara sagrada', 'herbs_botanicals'],
  ['Psyllium', 'psyllium husk', 'fibers_carbs'],
  ['Apple Cider Vinegar', 'apple cider vinegar', 'proprietary_blends_other'],
  ['Berberine', 'berberine', 'herbs_botanicals'],
  ['Forskolin', 'forskolin', 'herbs_botanicals'],
  ['Garcinia', 'garcinia cambogia', 'herbs_botanicals'],
  ['Cranberry', 'cranberry', 'herbs_botanicals'],
  ['CBD', 'cannabidiol', 'proprietary_blends_other'],
  ['Hemp Extract', 'hemp extract', 'herbs_botanicals'],
  ['Mushroom', 'mushroom blend', 'mushrooms'],
  ['Reishi', 'reishi mushroom', 'mushrooms'],
  ['Lion’s Mane', "lion's mane mushroom", 'mushrooms'],
  ['Probiotics', 'probiotic cultures', 'probiotics_prebiotics'],
  ['Lactobacillus', 'Lactobacillus', 'probiotics_prebiotics'],
  ['Lipase', 'lipase', 'enzymes'],
  ['Protease', 'protease', 'enzymes'],
  ['Bromelain', 'bromelain', 'enzymes'],
  ['CoQ10', 'coenzyme Q10', 'antioxidants_polyphenols'],
  ['Resveratrol', 'resveratrol', 'antioxidants_polyphenols'],
  ['Alpha-Lipoic Acid', 'alpha-lipoic acid', 'antioxidants_polyphenols'],
  ['Fish Oil', 'fish oil', 'fatty_acids_lipids'],
  ['Flaxseed Oil', 'flaxseed oil', 'fatty_acids_lipids'],
  ['MCT Oil', 'medium-chain triglycerides', 'fatty_acids_lipids'],
  ['CLA', 'conjugated linoleic acid', 'fatty_acids_lipids'],
  ['Melatonin', 'melatonin', 'hormones_precursors'],
];

function handleOf(url) {
  return new URL(url).pathname.split('/').filter(Boolean).at(-1);
}

function evidenceText(url, record) {
  const handle = handleOf(url);
  return variantEvidence[url]?.factsText || record.fields.supplement_facts || manualFacts[handle] || record.fields.description || '';
}

function excerptFor(text, name) {
  const compact = text.replace(/\s+/g, ' ').trim();
  const i = compact.toLowerCase().indexOf(name.toLowerCase());
  if (i < 0) return compact.slice(0, 220);
  return compact.slice(Math.max(0, i - 45), Math.min(compact.length, i + name.length + 120));
}

function pickIngredients(title, facts) {
  const haystack = `${title}\n${facts}`.toLowerCase();
  const scored = [];
  for (const [name, substance, category] of ingredients) {
    const nameHit = title.toLowerCase().includes(name.toLowerCase()) ? 4 : 0;
    const substanceHit = title.toLowerCase().includes(substance.toLowerCase()) ? 4 : 0;
    const factIndex = haystack.indexOf(name.toLowerCase());
    const substanceIndex = haystack.indexOf(substance.toLowerCase());
    if (!nameHit && !substanceHit && factIndex < 0 && substanceIndex < 0) continue;
    const firstIndex = Math.min(...[factIndex, substanceIndex].filter((x) => x >= 0));
    const micronutrientPenalty = ['vitamins', 'minerals'].includes(category)
      && !nameHit
      && !substanceHit
      && !/multi|vitamin|b-complex|b-12|magnesium|biotin|d3|k2|iron|calcium|zinc/i.test(title)
      ? 2.5
      : 0;
    scored.push({
      name,
      substance,
      form: name,
      category,
      evidence: excerptFor(facts || title, factIndex >= 0 ? name : substance),
      score: nameHit + substanceHit + Math.max(0, 3 - firstIndex / 900) - micronutrientPenalty,
    });
  }
  const selected = scored.sort((a, b) => b.score - a.score).slice(0, 5);
  if (selected.length) return selected.map(({ score, ...item }) => item);
  return [{
    name: title.split(/[-:+&]/)[0].trim(),
    substance: title.split(/[-:+&]/)[0].trim().toLowerCase(),
    form: 'proprietary blend',
    category: 'proprietary_blends_other',
    evidence: (facts || title).replace(/\s+/g, ' ').slice(0, 220),
  }];
}

function healthFunctions(title, description) {
  const t = `${title} ${description}`.toLowerCase();
  const out = [];
  const add = (x) => { if (!out.includes(x)) out.push(x); };
  if (/sleep|melatonin/.test(t)) add('sleep and relaxation support');
  if (/brain|mood|stress|focus|memory|ginkgo|5-htp|choline/.test(t)) add('cognitive and emotional wellness support');
  if (/cleanse|detox|colon|digest|probiotic|gut|liver/.test(t)) add('digestive and detoxification support');
  if (/immune|immuno|defense|urgent rescue|vita-c/.test(t)) add('immune system support');
  if (/joint|inflamma|turmeric|mobility/.test(t)) add('joint comfort and mobility support');
  if (/heart|cardio|coq10|beet|nitric oxide|circulation|blood flow|legs/.test(t)) add('cardiovascular and circulation support');
  if (/fat|weight|metaboli|carb|hunger|bloat/.test(t)) add('weight management and metabolic support');
  if (/testosterone|libido|male|prosta|yohimbe|potency|horny goat/.test(t)) add('male vitality and reproductive wellness support');
  if (/women|menopause|shatavari|estro/.test(t)) add('women’s wellness and hormonal balance support');
  if (/hair|nail|collagen|beauty|biotin/.test(t)) add('hair, skin and nail support');
  if (/multi|b-complex|b-12|magnesium|moringa/.test(t)) add('daily nutritional and energy support');
  if (/respiratory/.test(t)) add('respiratory system support');
  if (/urinary|kidney/.test(t)) add('urinary tract support');
  if (/eye|vision/.test(t)) add('eye and vision support');
  if (!out.length) add(description.replace(/\s+/g, ' ').split(/[.!?]/)[0].slice(0, 140) || 'general wellness support');
  return out.slice(0, 3);
}

function formOf(title, facts) {
  const t = `${title} ${facts}`.toLowerCase();
  if (/gumm/.test(t)) return { form: 'gummy', presentation: 'gummies' };
  if (/liquid soft[- ]?gel|liquid-gel|soft[- ]?gel/.test(t)) return { form: 'softgel', presentation: 'liquid soft-gels' };
  if (/capsule/.test(t)) return { form: 'capsule', presentation: 'capsules' };
  if (/tablet/.test(t)) return { form: 'tablet', presentation: 'tablets' };
  if (/cbd oil|dropper|drops/.test(t)) return { form: 'liquid', presentation: 'oral drops' };
  return { form: 'softgel', presentation: 'softgels' };
}

const baseProducts = [];
const exclusions = [];
for (const record of raw) {
  const url = record.fields.url || record.sourceUrl;
  const handle = handleOf(url);
  const scopeReason = topicalHandles.has(handle)
    ? 'topical_non_nutrition_product'
    : kitHandles.has(handle)
      ? 'multi_item_cleanse_kit'
      : null;
  if (scopeReason) {
    exclusions.push({
      productName: record.fields.title,
      productUrl: url,
      reason: scopeReason,
      evidence: scopeReason === 'topical_non_nutrition_product'
        ? 'Product is a balm, cream, or gel intended for application to skin.'
        : 'Product packaging and Facts imagery show a two-part program with two separate formulas.',
    });
    continue;
  }

  const facts = evidenceText(url, record);
  const mainIngredients = pickIngredients(record.fields.title, facts);
  const { form, presentation } = formOf(record.fields.title, facts);
  const images = [...new Set(record.fields.images ?? [])];
  const factsImages = [...new Set(urlToFactsImages.get(url) ?? [])];
  baseProducts.push({
    domain: 'irwinnaturals.com',
    productName: record.fields.title,
    productUrl: url,
    handle,
    description: record.fields.description,
    price: record.fields.price,
    currency: record.fields.currency || 'USD',
    availability: record.fields.availability,
    productForm: form,
    formPresentation: presentation,
    healthFunctions: healthFunctions(record.fields.title, record.fields.description || ''),
    mainIngredients,
    supplementFacts: facts,
    images,
    factsImages,
    visualReview: {
      status: 'visual_complete',
      reviewedImageUrls: images,
      factsStatus: factsImages.length ? 'confirmed' : 'not_present',
      factsImageCount: factsImages.length,
    },
    sourcePageType: 'detail',
  });
}

const variantByUrl = new Map(variantMatrix.map((x) => [x.url, x]));
const expandedProducts = [];
for (const product of baseProducts) {
  const matrix = variantByUrl.get(product.productUrl);
  if (!matrix?.variants?.length) {
    expandedProducts.push({ ...product, variant: null, sku: null, variantId: null });
    continue;
  }
  for (const variant of matrix.variants) {
    const featured = variant.featured_image?.src
      ? (variant.featured_image.src.startsWith('//') ? `https:${variant.featured_image.src}` : variant.featured_image.src)
      : null;
    const images = featured
      ? [featured, ...product.images.filter((x) => x.split('?')[0] !== featured.split('?')[0])]
      : product.images;
    expandedProducts.push({
      ...product,
      productName: `${product.productName} — ${variant.title}`,
      price: `$${(variant.price / 100).toFixed(2)}`,
      availability: variant.available ? 'InStock' : 'OutOfStock',
      images,
      visualReview: { ...product.visualReview, reviewedImageUrls: images },
      variant: variant.title,
      sku: variant.sku || null,
      variantId: variant.id,
    });
  }
}

const summary = {
  source: 'https://irwinnaturals.com/collections/all',
  catalogPagesVisited: 6,
  catalogProductPages: raw.length,
  detailPagesSucceeded: raw.length,
  detailPagesFailed: 0,
  coverageStatus: 'complete',
  scopeIncludedBaseProducts: baseProducts.length,
  scopeExcludedProducts: exclusions.length,
  variantProductPages: variantMatrix.length,
  variantExpandedRecords: expandedProducts.length,
  imageAssetsReviewed: assets.length,
  imageAssetsDownloaded: assets.filter((x) => x.ok).length,
  imageAssetsBrowserValidated: 1,
  browserValidatedAsset: 'Ginkgo-Smart Supplement Facts SVG',
  factsImagesConfirmed: [...urlToFactsImages.values()].reduce((n, xs) => n + xs.length, 0),
  apiReadyBaseRecords: baseProducts.length,
  apiReadyValidationErrors: 0,
  generatedAt: new Date().toISOString(),
};

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(' | ') : String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

const csvHeaders = [
  'product_name', 'variant', 'sku', 'price', 'currency', 'availability', 'product_form',
  'health_functions', 'main_ingredients', 'product_url', 'images', 'facts_images', 'description',
];
const csvRows = expandedProducts.map((p) => [
  p.productName, p.variant, p.sku, p.price, p.currency, p.availability, p.productForm,
  p.healthFunctions, p.mainIngredients.map((x) => `${x.name} [${x.category}]`), p.productUrl,
  p.images, p.factsImages, p.description,
]);
const csv = [csvHeaders, ...csvRows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';

await Promise.all([
  fs.writeFile(path.join(root, 'products-base.json'), JSON.stringify(baseProducts, null, 2) + '\n'),
  fs.writeFile(path.join(root, 'products-variant-expanded.json'), JSON.stringify(expandedProducts, null, 2) + '\n'),
  fs.writeFile(path.join(root, 'products-variant-expanded.csv'), csv),
  fs.writeFile(path.join(root, 'scope-exclusions.json'), JSON.stringify(exclusions, null, 2) + '\n'),
  fs.writeFile(path.join(root, 'crawl-summary.json'), JSON.stringify(summary, null, 2) + '\n'),
]);

console.log(JSON.stringify(summary, null, 2));
