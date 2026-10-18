// Rules applied to the text of a warning letter. Every match keeps the letter
// sentence it came from; nothing is reported without such a sentence.

// Offices whose letters are never about supplements or human food; their
// letter pages are not fetched.
export const EXCLUDED_OFFICE = /tobacco products|devices and radiological|biologics evaluation|veterinary medicine/i;

// Central food offices, used only when a letter page has no Product field.
export const FOOD_OFFICE = /food safety and applied nutrition|\bCFSAN\b|human foods program/i;

export const DIETARY_SUPPLEMENT = /dietary supplement/i;
export const FOOD_PRODUCT = /food|beverage/i;
export const ANIMAL_PRODUCT = /animal|veterinary/i;

export const VIOLATION_RULES = {
  cgmp: [/\b[cC]?GMPs?\b/, /current good manufacturing practice/i, /21 CFR (?:Part )?(?:111|117|110|210|211)\b/i],
  disease_claims: [
    /cure, mitigat\w*,? treat\w*,? or prevent\w* (?:of )?disease/i,
    /intended (?:for use )?(?:in|to|for) (?:the )?(?:diagnos|cure|mitigat|treat|prevent)\w*/i,
  ],
  unapproved_new_drug: [
    /unapproved new drugs?/i,
    /new drugs? (?:within the meaning of|as defined (?:in|by)|under) section 201\(p\)/i,
    /section 505\(a\)/i,
  ],
  prohibited_ingredient: [
    /201\(ff\)\(3\)\(B\)/,
    /excluded from the (?:dietary supplement )?definition/i,
    /(?:is|are) not (?:a )?dietary ingredients?/i,
    /does not (?:meet|qualify)[^.]{0,60}dietary ingredient/i,
    /cannot be (?:lawfully )?marketed as (?:a )?dietary supplement/i,
    /section 402\(f\)/i,
    /section 413\b/i,
    /new dietary ingredient[^.]{0,120}(?:notification|adulterated)/i,
    /undeclared (?:drug|active pharmaceutical|pharmaceutical)/i,
    /hidden (?:drug|active)/i,
    /FDA laboratory analysis[^.]{0,200}(?:confirm|reveal|found|show)/i,
  ],
  labeling: [/misbranded (?:within the meaning of|under) section 403/i, /section 403\([a-z]/i, /21 CFR 101\.\d/i],
  other: [/Foreign Supplier Verification/i, /\bFSVP\b/, /\bHACCP\b/, /section 402\(a\)\(4\)/i, /insanitary conditions/i, /failure to register/i],
};

// Substances that recur in supplement and food enforcement. A name is listed
// only when a plain-text match cannot be some other word; generic words
// ("protein", "extract") are deliberately absent.
const INGREDIENTS = [
  ['DMAA', /\bDMAA\b|1,3-dimethylamylamine|methylhexan(?:e)?amine/i],
  ['DMHA', /\bDMHA\b|2-aminoisoheptane|octodrine|2-amino-6-methylheptane/i],
  ['DMBA', /\bDMBA\b|1,3-dimethylbutylamine/i],
  ['BMPEA', /\bBMPEA\b|[βb]eta-methylphenethylamine/i],
  ['higenamine', /higenamine/i],
  ['hordenine', /hordenine/i],
  ['synephrine', /synephrine/i],
  ['yohimbine', /yohimbine|yohimbe/i],
  ['ephedra / ephedrine', /\bephedra\b|ephedrine/i],
  ['phenibut', /phenibut/i],
  ['picamilon', /picamilon/i],
  ['tianeptine', /tianeptine/i],
  ['kratom', /kratom|mitragyna speciosa|\bmitragynine/i],
  ['7-hydroxymitragynine', /7-hydroxymitragynine|\b7-OH\b/i],
  ['kava', /\bkava\b/i],
  ['vinpocetine', /vinpocetine/i],
  ['caffeine', /caffeine/i],
  ['SARMs', /selective androgen receptor modulator|\bSARMs?\b/i],
  ['ostarine', /ostarine|enobosarm|MK-2866/i],
  ['ligandrol', /ligandrol|LGD-4033/i],
  ['andarine', /andarine/i],
  ['testolone (RAD-140)', /RAD-?140|testolone/i],
  ['cardarine (GW501516)', /cardarine|GW-?501516/i],
  ['ibutamoren (MK-677)', /ibutamoren|MK-?677/i],
  ['stenabolic (SR9009)', /SR-?9009|stenabolic/i],
  ['DHEA', /\bDHEA\b|dehydroepiandrosterone/i],
  ['sildenafil', /\b\w*sildenafil\b/i],
  ['tadalafil', /\b\w*tadalafil\b/i],
  ['vardenafil', /\b\w*vardenafil\b/i],
  ['sibutramine', /\b\w*sibutramine\b/i],
  ['phenolphthalein', /phenolphthalein/i],
  ['fluoxetine', /fluoxetine/i],
  ['lorcaserin', /lorcaserin/i],
  ['phentermine', /phentermine/i],
  ['bisacodyl', /bisacodyl/i],
  ['dexamethasone', /dexamethasone/i],
  ['diclofenac', /diclofenac/i],
  ['meloxicam', /meloxicam/i],
  ['methocarbamol', /methocarbamol/i],
  ['semaglutide', /semaglutide/i],
  ['tirzepatide', /tirzepatide/i],
  ['cannabidiol (CBD)', /cannabidiol|\bCBD\b/i],
  ['delta-8 THC', /delta-?8|Δ-?8/i],
  ['THC', /\bTHC\b|tetrahydrocannabinol/i],
  ['hemp', /\bhemp\b/i],
  ['tejocote', /tejocote|crataegus mexicana/i],
  ['yellow oleander', /yellow oleander|thevetia peruviana|cascabela thevetia/i],
  ['nuez de la India', /nuez de la india/i],
  ['red yeast rice', /red yeast rice/i],
  ['lovastatin / monacolin K', /lovastatin|monacolin/i],
  ['comfrey', /comfrey/i],
  ['aristolochic acid', /aristolochic/i],
  ['amygdalin (laetrile)', /amygdalin|laetrile|vitamin B-?17/i],
  ['cesium chloride', /cesium chloride/i],
  ['chlorine dioxide (MMS)', /chlorine dioxide|miracle mineral/i],
  ['colloidal silver', /colloidal silver/i],
  ['methylene blue', /methylene blue/i],
  ['N-acetyl cysteine (NAC)', /N-acetyl-?L?-?cysteine|\bNAC\b/i],
  ['melatonin', /melatonin/i],
  ['ashwagandha', /ashwagandha|withania somnifera/i],
  ['turmeric / curcumin', /turmeric|curcumin/i],
  ['elderberry', /elderberry|sambucus/i],
  ['echinacea', /echinacea/i],
  ['ginseng', /ginseng/i],
  ['ginkgo', /ginkgo/i],
  ["St. John's wort", /st\.? john['’]?s wort|hypericum/i],
  ['black cohosh', /black cohosh/i],
  ['garcinia cambogia', /garcinia/i],
  ['green tea extract', /green tea extract/i],
  ['berberine', /berberine/i],
  ['quercetin', /quercetin/i],
  ['vitamin C', /vitamin C\b|ascorbic acid/i],
  ['vitamin D', /vitamin D\d?\b|cholecalciferol/i],
  ['zinc', /\bzinc\b/i],
  ['ivermectin', /ivermectin/i],
  ['hydroxychloroquine', /hydroxychloroquine/i],
  ['5-HTP', /5-HTP|5-hydroxytryptophan/i],
  ['sodium nitrite', /sodium nitrite/i],
];

export function matchIngredients(sentence) {
  return INGREDIENTS.filter(([, re]) => re.test(sentence)).map(([name]) => name);
}

// Domains named in the letter, minus government and reference sites.
const DOMAIN = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:com|net|org|co|us|shop|store|info|biz|io|health|life|ca|uk|au|in|cn|de|fr|mx|nz|eu|online|site|xyz|me|tv))\b/gi;
const NOT_COMPANY = /(?:^|\.)(?:fda\.gov|hhs\.gov|regulations\.gov|ecfr\.gov|govinfo\.gov|federalregister\.gov|accessdata\.fda\.gov|ftc\.gov|cdc\.gov|nih\.gov|usda\.gov|gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|aol\.com|icloud\.com)$/i;
export const MARKETPLACE = /(?:^|\.)(?:amazon\.[a-z.]+|ebay\.com|etsy\.com|walmart\.com|facebook\.com|instagram\.com|youtube\.com|tiktok\.com|twitter\.com|x\.com|linkedin\.com|pinterest\.com|shopify\.com|alibaba\.com|aliexpress\.com)$/i;

export function domainsIn(text) {
  const out = [];
  for (const m of text.matchAll(DOMAIN)) {
    const d = m[1].toLowerCase().replace(/^www\./, '');
    if (!NOT_COMPANY.test(d) && !/^\d/.test(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

export const WEBSITE_CONTEXT = /web ?sites?|internet|online|social media|www\.|https?:\/\//i;
