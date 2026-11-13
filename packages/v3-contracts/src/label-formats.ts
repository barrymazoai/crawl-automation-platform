import { z } from "zod";

/**
 * KAN-243 (owner 2026-11-05): the printed label formats a storefront sells under. A storefront picks which formats its
 * labels may be in; each format brings the words that select a label image, how its value columns are headed and what
 * the vision copy is told about it. Which column is a %DV or a %RDA is read from the printed column header, never
 * from the storefront: amazon.in also sells imported US bottles printing Supplement Facts.
 *
 * A format is named with its version. Its keywords, headers and prompt lines are part of what that name means, so a
 * change is a new version, never an edit (the name travels in every task's keyword policy and retained answer).
 */
export const LabelFormatIdSchema = z.enum([
  "us-facts/1",
  "in-nutritional-information/1",
  "in-composition/1",
  "in-nutritional-information/2",
  "in-composition/2",
  "in-nutritional-information/3",
  "in-composition/3",
  "eu-food-supplement/1",
  "es-food-supplement/1",
]);
export type LabelFormatId = z.infer<typeof LabelFormatIdSchema>;

/** The US Supplement / Nutrition Facts panel, which every label rule was written for. */
export const US_FACTS: LabelFormatId = "us-facts/1";

/** Whose recommended intake a printed percentage column is relative to. */
export type DailyValueBasis = "us_dv" | "in_rda" | "eu_nrv" | "ca_dv";

export interface LabelFormat {
  /** Whole-word OCR phrases that select an image for this format (letters and single spaces only). */
  keywords: readonly string[];
  /** Printed value-column headers, read by their role. */
  columns: {
    amount: readonly RegExp[];
    /** An amount column on a fixed basis instead of per serving ("Qty/100g"). */
    perBasis: readonly RegExp[];
    dailyValue: readonly { header: RegExp; basis: DailyValueBasis }[];
  };
  /** Cells that only name a column ("Nutrients"), skipped when a row prints nothing else. */
  headerCells: readonly RegExp[];
  /** Lines that are headings or footnotes of this format, never a row. */
  skip: readonly RegExp[];
  /** Servings-per-pack lines this format prints ("Servings Per Pack: 30"). */
  servings: readonly RegExp[];
  /**
   * Lines naming the serving a list is printed for ("Each capsule contains:"), group 1 being the serving and an
   * optional group 2 the servings per pack printed on the same line ("Serv Size - 2.38 g … Servings per pack - 30").
   */
  servingFor: readonly RegExp[];
  /** A name-only line that continues the row above it ("(Magnesium bisglycinate buffered with …)"). */
  continuation?: readonly RegExp[];
  /** Lines saying the amounts below are the raw herbs the product is made from, not its contents. */
  preparedFrom: readonly RegExp[];
  /** What the vision copy is told about this format, appended to the US prompt. */
  prompt: readonly string[];
}

const none: readonly RegExp[] = [];

// amazon.in, 2026-11-06 (20 real labels, docs/plans/KAN-243-india-research.md §10.7): headers with a footnote mark in
// front ("*%RDA", "#%RDA", "**%RDA Per Serve", "*% RDA Men"), "% Daily Values†*", "Each Serving Provides",
// "Per 30ml"; serving lines inside the table ("Serve Size: 30ml", "Serv Size - 2.38 g (1 sachet) Servings per pack
// - 30", "1 SERVING (1=1 TABLET)"); section headings ("VITAMINS^", "MINERALS"); "(Approximate Composition)";
// a description line under its ingredient. Everything /1 reads, /2 reads the same way.
const IN_NUTRITIONAL_INFORMATION_2: LabelFormat = {
  keywords: ["Nutritional Information", "Nutrition Information", "Nutritional Facts", "RDA"],
  columns: {
    amount: [
      /^(?:qty|quantity|amount)\.?\s*(?:\/|per)\s*(?:serving|serve|tablet|capsule|sachet|scoop|dose)s?\b.*$/i,
      /^per\s+(?:serving|serve|tablet|capsule|sachet|scoop|dose)s?\b.*$/i,
      /^each\s+(?:serving|serve|tablet|capsule|sachet|scoop|dose)s?\s+(?:provides|contains)\b.*$/i,
      /^per\s+(?!100\s*(?:g|gm|ml)\b)\d+(?:\.\d+)?\s*(?:g|gm|ml|mg)\b.*$/i,
      // amazon.in copies, 2026-11-07: "Approx Value Per Serving" (Naturaltein), "Approx. Value per serving" (WOW),
      // "QUANTITY" (Wellbeing Nutrition), and the serving's own weight "3.1 g" beside "100 g" (Nutrabay).
      /^(?:approx\.?\s*)?(?:value|amount|qty|quantity)\s+per\s+(?:serving|serve|tablet|capsule|softgel|sachet|scoop|dose)s?\b.*$/i,
      /^(?:qty|quantity|amount)\.?$/i,
      /^(?!100\s*(?:g|gm|ml)$)\d+(?:\.\d+)?\s*(?:g|gm|ml|mg)$/i,
    ],
    perBasis: [
      /^(?:(?:qty|quantity|amount)\.?\s*)?(?:\/|per)\s*100\s*(?:g|gm|ml)\b.*$/i,
      /^100\s*(?:g|gm|ml)$/i,
      // "ENSURE® Powder (per 100 g)", "Powder (per 100 g)" (Abbott, 2026-11-06)
      /^.{0,60}\(\s*per\s*100\s*(?:g|gm|ml)\s*\)$/i,
    ],
    dailyValue: [
      // A leading footnote mark: "**%RDA Per Serve", "^%RDA Per Serve" (amazon.in copies, 2026-11-06).
      { header: /^[*#†‡^]*\s*%?\s*rda\b.*$/i, basis: "in_rda" },
      // "Per Serve % RDA" (Organic India Isabgol, 2026-11-07) is the percentage column, not a per-serving amount.
      { header: /%\s*rda\b/i, basis: "in_rda" },
      { header: /^[*#†‡^]*\s*%?\s*(?:dv|daily\s*values?)\s*%?\s*[*†‡]*$/i, basis: "us_dv" },
    ],
  },
  headerCells: [
    /^(?:nutrients?|nutritional\s+information|nutrition\s+information|parameters?|ingredients?|contents?)\b.*$/i,
    /^(?:vitamins?|minerals?|amino\s+acids?|herbal\s+extracts?|botanicals?|probiotics?|antioxidants?)\s*[\^*#:]*$/i,
  ],
  skip: [
    /^nutritional?\s+(?:information|facts)\b/i,
    /^nutrition\s+information\b/i,
    /\brda\s+not\s+(?:established|set)\b/i,
    /recommended\s+dietary\s+allowance/i,
    /^[*#†‡]+\s*rda\b/i,
    /^approx\.?\s*values?\b/i,
    /^\(?approx\.?\)?$/i,
    /^\(?approximate\s+composition\)?/i,
    /^(?:vitamins?|minerals?|amino\s+acids?|others?|herbal\s+extracts?|botanicals?|probiotics?|antioxidants?)\s*[\^*#:§]*$/i,
    // amazon.in copies, 2026-11-07: notes copied as rows, never an ingredient: "(Approximate values)",
    // "(Approx. Values)", "90 TABLETS", "This pack contains about 35 serves with Milk", "Each serving provides
    // (%RDA)", "EACH SERVING OF OMEFISH ULTRA PROVIDES".
    /^\(\s*approx(?:imate|\.)?\s*values?\s*\)$/i,
    /^\d+\s*(?:n\s+)?(?:veg(?:etarian)?\s+)?(?:tablets?|capsules?|softgels?|gummies|sachets?)$/i,
    /^this\s+pack\s+contains\b/i,
    /^each\s+serving\b.*\bprovides\b/i,
  ],
  servings: [
    // "Number of Servings per pack 30" (amazon.in, Luna high copy 2026-11-08) as well as "No. of servings".
    /^(?:(?:no\.?|number)\s*of\s+)?servings?\s*per\s*(?:pack|bottle|jar|container)\s*[:\-–]?\s*(.*)$/i,
    /^(?:no\.?|number)\s*of\s+servings?\s*[:\-–]?\s*(.*)$/i,
  ],
  servingFor: [
    /^serv(?:e|ing)?\.?\s+size\s*[:\-–]?\s*(.+?)(?:\s+servings?\s+per\s+(?:pack|bottle|jar|container)\s*[:\-–]?\s*(.+))?$/i,
    /^(1\s+serving\s*\(.+\))$/i,
    // "1 levelled scoop serving = 38g • No. of servings: 26 (approx)" (The Whole Truth plant protein, amazon.in
    // spot check 2026-11-07): the serving and the pack's count on one line.
    // Copied as "1 levelled scoop serving - 38g" and "Levelled scoop serving = 35 g" too (Luna high, 2026-11-08).
    /^((?:\d+\s+)?(?:[a-z]+\s+){0,3}?(?:scoops?|tablets?|capsules?|softgels?|sachets?|serv(?:e|ing)s?)\b[^•|=–-]*[=–-]\s*\d+(?:\.\d+)?\s*(?:g|gm|ml|mg))\s*(?:[•|·,;]\s*no\.?\s*of\s+servings?\s*[:\-–]?\s*(.+))?$/i,
  ],
  continuation: [/^\(.+\)$/],
  preparedFrom: none,
  prompt: [
    'The label may print an Indian "Nutritional Information" table instead (columns such as "Qty./Serving", "Qty/100g", "%RDA"). Transcribe it the same way: one cell per printed column, and each %RDA cell exactly as printed even when it is a bare number ("100", "0.20") or "**".',
    '"columnHeaders": every column header as printed, left to right, including the name column\'s header (e.g. "Nutrients") when one is printed; "" for a column without a header.',
  ],
};

/**
 * amazon.co.uk, 2026-11-10 (owner: "印度…如果他们很像的话，就用一样的"): the UK prints the same "Nutritional
 * Information" table, its percentage column relative to the Nutrient Reference Value and its amount column headed per
 * daily intake. Real UK labels (docs/plans/KAN-243-uk-plan.md §1): Vitabiotics "Av. per Tablet | %NRV", Nutrition
 * Geeks "Per Daily Intake (Two Capsules) | %NRV*" with "**Nutrient Reference Value Not Established", Zipvit "Per
 * Serving | %NRV", BetterYou "Each daily dose (3 sprays) contains", Optimum Nutrition "Typical Values | Per 3.4 g".
 * Everything /2 reads, /3 reads the same way.
 */
const IN_NUTRITIONAL_INFORMATION_3: LabelFormat = {
  ...IN_NUTRITIONAL_INFORMATION_2,
  keywords: [...IN_NUTRITIONAL_INFORMATION_2.keywords, "NRV"],
  columns: {
    amount: [
      ...IN_NUTRITIONAL_INFORMATION_2.columns.amount,
      /^(?:av(?:erage)?\.?|typical)\s*(?:\/|per)\s*(?:\d+\s+)?(?:serving|serve|tablet|caplet|capsule|softgel|sachet|scoop|dose|spray|gumm(?:y|ies)|drops?)s?\b.*$/i,
      /^per\s+(?:\d+\s+|daily\s+)?(?:serving|serve|tablet|caplet|capsule|softgel|sachet|scoop|dose|spray|gumm(?:y|ies)|drops?|intake)s?\b.*$/i,
      /^each\s+(?:daily\s+)?(?:serving|serve|tablet|caplet|capsule|softgel|sachet|scoop|dose|spray)s?\b.*\b(?:provides|contains)\b.*$/i,
    ],
    perBasis: IN_NUTRITIONAL_INFORMATION_2.columns.perBasis,
    dailyValue: [
      ...IN_NUTRITIONAL_INFORMATION_2.columns.dailyValue,
      { header: /^[*#†‡^]*\s*%?\s*nrv\b.*$/i, basis: "eu_nrv" },
      { header: /%\s*nrv\b/i, basis: "eu_nrv" },
      { header: /^[*#†‡^]*\s*%\s*ri\b.*$/i, basis: "eu_nrv" },
    ],
  },
  headerCells: [...IN_NUTRITIONAL_INFORMATION_2.headerCells, /^typical\s+values?\b.*$/i],
  skip: [
    ...IN_NUTRITIONAL_INFORMATION_2.skip,
    /\bnrv\b.*\bnot\s+(?:established|set)\b/i,
    /^[*#†‡]*\s*nutrient\s+reference\s+values?\b/i,
    /^[*#†‡]+\s*nrv\b/i,
  ],
  prompt: [
    'The label may print an Indian or UK "Nutritional Information" table instead (columns such as "Qty./Serving", "Av. per Tablet", "Per Daily Intake (Two Capsules)", "Qty/100g", "%RDA", "%NRV"). Transcribe it the same way: one cell per printed column, and each %RDA or %NRV cell exactly as printed even when it is a bare number ("100", "0.20") or "**".',
    IN_NUTRITIONAL_INFORMATION_2.prompt[1]!,
  ],
};

// Composition lists as /1; "Excipients q.s." is the filler, not a formula row (Kapiva Shilajit, 2026-11-06).
const IN_COMPOSITION_2: LabelFormat = {
    keywords: ["Composition"],
    columns: { amount: none, perBasis: none, dailyValue: [] },
    headerCells: none,
    skip: [/^composition\s*:?$/i, /^excipients?\b.*$/i],
    servings: none,
    servingFor: [/^(?:composition\s*:?\s*)?each\s+(.+?)\s+contains\s*:?$/i],
    continuation: [/^\(.+\)$/],
    preparedFrom: [
      /^(?:composition\s*:?\s*)?each\s+.+?\s+(?:is\s+)?prepared\s+(?:from|out\s+of)\b/i,
    ],
    prompt: [
      'A "Composition" list ("Each capsule contains:", "Each 1g contains:") is a facts panel too: "heading" is its heading as printed, the "Each … contains" line goes in "servingLines" as printed, and each ingredient is one row whose cells are its name exactly as printed (Latin name and plant part included) and its amount.',
    ],
  };

/**
 * amazon.ca, 2026-11-11 (7 real galleries, docs/plans/KAN-243-canada-plan.md §1): Health Canada's natural health
 * product labels, printed in English and French. "Medicinal ingredients" with "Each tablet contains:" (Webber
 * Naturals, Jamieson), "Ingredients (each softgel contains):" (NOW Canada), the "Product Facts / Info-produit" box with
 * "(In each softgel)" or "Each capsule contains:" (Sports Research, CanPrev), "Medicinal ingredient – each serving
 * (10 g) contains" (Organika), and a Supplement Facts–like table headed "Amount Per Serving / Quantité par portion |
 * %DV / %VQ" (Jacked Factory). "Non-medicinal ingredients" already heads an other-ingredients list. /3 is /2 with these
 * lines; /2 stays for amazon.in and amazon.co.uk.
 */
const IN_COMPOSITION_3: LabelFormat = {
  ...IN_COMPOSITION_2,
  keywords: [...IN_COMPOSITION_2.keywords, "Medicinal Ingredients", "Medicinal Ingredient", "Product Facts"],
  columns: {
    amount: [/^amount\s+per\s+serving\s*\/\s*quantit[ée]\s+par\s+portion$/i],
    perBasis: none,
    dailyValue: [{ header: /^%\s*(?:dv|daily\s+value)\s*\/\s*%\s*(?:vq|valeur\s+quotidienne)\s*[*†‡]*$/i, basis: "ca_dv" }],
  },
  skip: [
    ...IN_COMPOSITION_2.skip,
    /^product\s+facts\b.*$/i,
    /^info-produit\b.*$/i,
    /^medicinal\s+ingredients?\s*(?:\/\s*ingr[ée]dients?\s+m[ée]dicinaux)?\s*:?$/i,
    /^ingr[ée]dients?\s+m[ée]dicinaux\s*:?$/i,
    /^chaque\s+.+?\s+contient\b.*$/i,
    /^\(?\s*dans\s+chaque\s+.+$/i,
  ],
  servingFor: [
    // "Each tablet contains:", "Medicinal Ingredients: Each tablet contains:", "Ingredients (each softgel contains):",
    // "Medicinal ingredient – each serving (10 g) contains"; the French half after a "/" is left out of the serving.
    /^(?:(?:composition|(?:medicinal\s+)?ingredients?)\s*[:\-–—(]?\s*)?each\s+(.+?)\s+contains\s*\)?\s*:?(?:\s*\/.*)?$/i,
    // "(In each softgel)".
    /^\(\s*in\s+each\s+(.+?)\s*\)\s*:?(?:\s*\/.*)?$/i,
  ],
  prompt: [
    ...IN_COMPOSITION_2.prompt,
    'A Canadian label prints its "Medicinal ingredients" ("Each tablet contains:", "(In each softgel)") and "Non-medicinal ingredients" in English and in French. Transcribe the English text only and leave out every French translation ("Ingrédients médicinaux", "Chaque comprimé contient :", "Vitamine D3", "Ingrédients non médicinaux"). The medicinal ingredients are the facts panel: the "Each … contains" or "(In each …)" line goes in "servingLines" as printed, and each medicinal ingredient is one row with its amount; the non-medicinal ingredients are the other ingredients.',
  ],
};

/**
 * amazon.de, 2026-11-11 (13 galleries of our brands + 3 German brands, docs/plans/KAN-243-germany-plan.md §1): a German
 * food-supplement label. Importers relabel US bottles with a peel-off multilingual sticker whose DE section prints
 * "Inhaltsstoffe | Tagesdosis (2 Weichkapseln)" with "Gesamt-Omega-3 1280mg / davon EPA 650mg" (Nordic Naturals) or
 * "… | Tagesdosis (2 Kapseln) | %NRV*" (Doctor's Best), then "Zutaten: …" and "Verzehrempfehlung: …"; German brands
 * print "Nährstofftabelle" / "Nährwertinformationen" with "Nährwertangaben pro Portion | %NRV*" (WeightWorld) or
 * "Inhalt pro Tablette: | NRV*" (Nutravita) and "*NRV: Nährstoffbezugswerte". The copy keeps every word as printed, in
 * German: translating it into English is a later step, never the copy's (owner 2026-11-11, plan option A).
 */
const EU_FOOD_SUPPLEMENT_1: LabelFormat = {
  keywords: ["Inhaltsstoffe", "Zutaten", "Tagesdosis", "Verzehrempfehlung", "Inhalt pro", "NRV"],
  columns: {
    amount: [
      /^(?:pro\s+)?tagesdosis\b.*$/i,
      /^(?:pro|je)\s+(?:tages)?(?:portion|dosis|tablette|kapsel|weichkapsel|kautablette|messl[öo]ffel|beutel|tropfen)\w*\b.*$/i,
      /^(?:pro|je)\s+\d+\s+[a-zäöüß]+.*$/i,
      /^(?:inhalt|menge|gehalt)\s+(?:pro|je)\s+(?!100\s*(?:g|ml)\b).+$/i,
    ],
    perBasis: [/^(?:(?:inhalt|menge|gehalt)\s+)?(?:pro|je)\s+100\s*(?:g|ml)\b.*$/i],
    dailyValue: [
      { header: /^[*#†‡^]*\s*%?\s*(?:nrv|rm|referenzmenge)\b.*$/i, basis: "eu_nrv" },
      { header: /%\s*(?:der\s+|des\s+)?(?:nrv|rm|referenzmenge)\b/i, basis: "eu_nrv" },
    ],
  },
  headerCells: [
    /^(?:inhaltsstoffe?|n[äa]hrstoffe?|zutaten|wirkstoffe?|bestandteile|n[äa]hrwerte)\s*[:*]*$/i,
    // WeightWorld heads its name column "Nährwertangaben pro Portion" and leaves the amount column without a header.
    /^n[äa]hrwertangaben\s+(?:pro|je)\s+(?:portion|tagesdosis)\b.*$/i,
  ],
  skip: [
    /^n[äa]hr(?:stoff|wert)(?:tabelle|informationen?|angaben)\s*:?$/i,
    /^[*#†‡]+\s*(?:nrv|rm)\b.*$/i,
    /^[*#†‡]*\s*(?:nrv|rm)\s*[:=]\s*.*$/i,
    /^[*#†‡]*\s*n[äa]hrstoffbezugswerte?\b.*$/i,
    /^[*#†‡]*\s*referenzmengen?\b.*$/i,
    /^[*#†‡]*\s*keine?\s+(?:nrv|rm|referenzmenge|empfehlung)\b.*$/i,
    /^nahrungserg[äa]nzungsmittel\b.*$/i,
    // Doctor's Best (B09LR81NNL): "* = Prozentsatz der Nährstoff-Referenzwerte …", "** = Tageswert nicht ermittelt".
    /^[*#†‡]+\s*=?\s*(?:prozentsatz|tageswert|n[äa]hrstoff-?referenzwert)\b.*$/i,
  ],
  servings: [/^portionen\s+(?:pro|je)\s+(?:packung|dose|flasche|beutel|glas)\s*[:\-–]?\s*(.*)$/i],
  servingFor: [
    // "Verzehrempfehlung: 1 Tablette alle 2 Tage | Portionen pro Packung: 365" (WeightWorld).
    /^verzehrempfehlung\s*:?\s*(.+?)(?:\s*[|•·]\s*portionen\s+(?:pro|je)\s+(?:packung|dose|flasche)\s*[:\-–]?\s*(.+))?$/i,
  ],
  continuation: [/^\(.+\)$/],
  preparedFrom: none,
  prompt: [
    'The label may print a German food-supplement table instead ("Inhaltsstoffe | Tagesdosis (2 Kapseln) | %NRV*", "Nährstofftabelle", "Nährwertinformationen", "Inhalt pro Tablette"). Transcribe it the same way, every word exactly as printed in German: never translate. Rows such as "davon EPA" are their own rows. Its "Zutaten:" list is the ingredients text: "otherIngredientsHeading" is "Zutaten:" as printed and "otherIngredients" its whole body as printed.',
    'A multilingual label prints the same text once per language, each section marked by a country or language code ("DE", "FR", "IT", "UK", "EN"). Copy the English section (UK, EN or GB) when one is printed, otherwise the German (DE) section only; leave every other language out.',
  ],
};

/**
 * amazon.es, 2026-11-13 (docs/plans/KAN-243-spain-plan.md §5): our brands' Spanish listings show the importer's peel-off
 * multilingual sticker with its Spanish (ES) section enlarged, so the copy reads Spanish, not the German section the EU
 * format asks for (Doctor's Best B09BVX2XS7 was copied in Spanish under that format and its "Ingredientes:" heading
 * refused). The ES section prints "Ingredientes | Dosis (2 comprimidos) | %VRN*" (Doctor's Best) or "Ingredientes |
 * Dosis diaria (2 cucharaditas) | %NRV*" with "de los cuales azúcar" rows (Nordic Naturals B0CF5QJMFK), then
 * "Ingredientes: …", "Modo de empleo: …" or "Recomendación de consumo: …", and the footnotes "*= Porcentaje de los
 * valores de referencia de nutrientes según el Reglamento (UE) nº 1169/2011" and "** = Necesidad diaria no
 * determinada". The copy keeps every word as printed, in Spanish: translating it into English is a later step.
 */
const ES_FOOD_SUPPLEMENT_1: LabelFormat = {
  keywords: ["Ingredientes", "Dosis diaria", "Modo de empleo", "Complemento alimenticio", "VRN", "NRV"],
  columns: {
    amount: [
      /^(?:por\s+)?dosis(?:\s+diaria)?\b.*$/i,
      /^(?:por|cada)\s+(?:porci[oó]n|raci[oó]n|comprimido|c[aá]psula|perla|cucharad|cacito|sobre|gota)\w*\b.*$/i,
      /^(?:cantidad|contenido)\s+(?:por|en)\s+(?!100\s*(?:g|ml)\b).+$/i,
    ],
    perBasis: [/^(?:(?:cantidad|contenido)\s+)?(?:por|en)\s+100\s*(?:g|ml)\b.*$/i],
    dailyValue: [
      { header: /^[*#†‡^]*\s*%?\s*(?:vrn|nrv|cdr|ir)\b.*$/i, basis: "eu_nrv" },
      { header: /%\s*(?:de\s+(?:los\s+)?)?(?:vrn|nrv|cdr|ir)\b/i, basis: "eu_nrv" },
    ],
  },
  headerCells: [
    /^(?:ingredientes?|componentes?|nutrientes?|informaci[oó]n\s+nutricional|valores?\s+nutricionales?)\s*[:*]*$/i,
  ],
  skip: [
    /^informaci[oó]n\s+nutricional\s*:?$/i,
    /^[*#†‡]+\s*=?\s*(?:porcentaje|necesidad|valores?\s+de\s+referencia|vrn|nrv|cdr|ir)\b.*$/i,
    /^[*#†‡]*\s*(?:vrn|nrv|cdr|ir)\s*[:=]\s*.*$/i,
    /^complemento\s+alimenticio\b.*$/i,
  ],
  servings: [
    /^(?:porciones|raciones|dosis)\s+por\s+(?:envase|paquete|bote|frasco|lata)\s*[:\-–]?\s*(.*)$/i,
  ],
  servingFor: [
    /^(?:modo\s+de\s+empleo|recomendaci[oó]n\s+de\s+consumo|dosis\s+diaria\s+recomendada)\s*:?\s*(.+)$/i,
  ],
  continuation: [/^\(.+\)$/],
  preparedFrom: none,
  prompt: [
    'The label may print a Spanish food-supplement table instead ("Ingredientes | Dosis (2 comprimidos) | %VRN*", "Dosis diaria (2 cucharaditas) | %NRV*", "Información nutricional"). Transcribe it the same way, every word exactly as printed in Spanish: never translate. Rows such as "de los cuales azúcar" are their own rows. Its "Ingredientes:" list is the ingredients text: "otherIngredientsHeading" is "Ingredientes:" as printed and "otherIngredients" its whole body as printed.',
    'A multilingual label prints the same text once per language, each section marked by a country or language code ("ES", "DE", "FR", "IT", "UK", "EN"). Copy the English section (UK, EN or GB) when one is printed, otherwise the Spanish (ES) section only; leave every other language out.',
  ],
};

export const LABEL_FORMATS: Readonly<Record<LabelFormatId, LabelFormat>> = {
  // The US rules live in the transcript parser and the US prompt themselves; this entry adds nothing to them.
  "us-facts/1": {
    keywords: [
      "Supplement Facts",
      "Nutrition Facts",
      "Ingredients",
      "Other Ingredients",
      "Amount Per Serving",
      "Daily Value",
      "Servings Per Container",
    ],
    columns: {
      amount: [/^amount(?:\s*(?:per|\/)\s*serving)?$/i, /^per\s+serving$/i],
      perBasis: none,
      dailyValue: [{ header: /^%?\s*(?:dv|daily\s*value)\s*%?\s*[*†‡]*$/i, basis: "us_dv" }],
    },
    headerCells: none,
    skip: none,
    servings: none,
    servingFor: none,
    preparedFrom: none,
    prompt: [],
  },
  // FSSAI Labelling & Display 2020 / Nutra 2022: "Nutritional Information (Approx.)", columns per serving, per 100 g
  // and %RDA (ICMR-NIN); "**" marks a nutrient without an RDA. Examples: Tata 1mg Magnesium, HK Vitals, HealthyHey.
  "in-nutritional-information/1": {
    keywords: ["Nutritional Information", "Nutrition Information", "Nutritional Facts", "RDA"],
    columns: {
      amount: [
        /^(?:qty|quantity|amount)\.?\s*(?:\/|per)\s*(?:serving|serve|tablet|capsule|sachet|scoop|dose)s?\b.*$/i,
        /^per\s+(?:serving|serve|tablet|capsule|sachet|scoop|dose)s?\b.*$/i,
      ],
      perBasis: [/^(?:(?:qty|quantity|amount)\.?\s*)?(?:\/|per)\s*100\s*(?:g|gm|ml)\b.*$/i],
      dailyValue: [
        { header: /^%?\s*rda\b.*$/i, basis: "in_rda" },
        { header: /^%?\s*(?:dv|daily\s*value)\s*%?\s*[*†‡]*$/i, basis: "us_dv" },
      ],
    },
    headerCells: [
      /^(?:nutrients?|nutritional\s+information|nutrition\s+information|parameters?|ingredients?)\s*[*†‡]*$/i,
    ],
    skip: [
      /^nutritional?\s+(?:information|facts)\b/i,
      /^nutrition\s+information\b/i,
      /\brda\s+not\s+(?:established|set)\b/i,
      /recommended\s+dietary\s+allowance/i,
      /^\*+\s*rda\b/i,
      /^approx\.?\s*values?\b/i,
      /^\(?approx\.?\)?$/i,
    ],
    servings: [
      /^(?:no\.?\s*of\s+)?servings?\s*per\s*(?:pack|bottle|jar|container)\s*:?\s*(.*)$/i,
      /^no\.?\s*of\s+servings?\s*:?\s*(.*)$/i,
    ],
    servingFor: none,
    preparedFrom: none,
    prompt: [
      'The label may print an Indian "Nutritional Information" table instead (columns such as "Qty./Serving", "Qty/100g", "%RDA"). Transcribe it the same way: one cell per printed column, and each %RDA cell exactly as printed even when it is a bare number ("100", "0.20") or "**".',
      '"columnHeaders": every column header as printed, left to right, including the name column\'s header (e.g. "Nutrients") when one is printed; "" for a column without a header.',
    ],
  },
  // AYUSH proprietary medicines and drug-licensed nutraceuticals: "Composition: Each capsule contains: Ashwagandha
  // (Withania somnifera) Root Extract 300 mg". Examples: Kapiva Shilajit, Carbamide B12. A classical formulation
  // "Each 100 g is prepared from" lists raw herb quantities (Dabur Chyawanprash), which are not the product's contents.
  "in-composition/1": {
    keywords: ["Composition"],
    columns: { amount: none, perBasis: none, dailyValue: [] },
    headerCells: none,
    skip: [/^composition\s*:?$/i],
    servings: none,
    servingFor: [/^(?:composition\s*:?\s*)?each\s+(.+?)\s+contains\s*:?$/i],
    preparedFrom: [
      /^(?:composition\s*:?\s*)?each\s+.+?\s+(?:is\s+)?prepared\s+(?:from|out\s+of)\b/i,
    ],
    prompt: [
      'A "Composition" list ("Each capsule contains:", "Each 1g contains:") is a facts panel too: "heading" is its heading as printed, the "Each … contains" line goes in "servingLines" as printed, and each ingredient is one row whose cells are its name exactly as printed (Latin name and plant part included) and its amount.',
    ],
  },
  "in-nutritional-information/2": IN_NUTRITIONAL_INFORMATION_2,
  "in-nutritional-information/3": IN_NUTRITIONAL_INFORMATION_3,
  "in-composition/2": IN_COMPOSITION_2,
  "in-composition/3": IN_COMPOSITION_3,
  "eu-food-supplement/1": EU_FOOD_SUPPLEMENT_1,
  "es-food-supplement/1": ES_FOOD_SUPPLEMENT_1,
};

/** The formats a storefront's labels are read in. A storefront not listed is not read at all. */
export const MARKETPLACE_LABEL_FORMATS: Readonly<Record<string, readonly LabelFormatId[]>> = {
  "amazon.com": [US_FACTS],
  // Owner 2026-11-06: /2 reads the table wording of the first 20 real amazon.in labels; /1 stays for its answers.
  "amazon.in": [US_FACTS, "in-nutritional-information/2", "in-composition/2"],
  // Owner 2026-11-10: the UK reads India's formats; /3 adds the UK's %NRV and per-daily-intake headers.
  "amazon.co.uk": [US_FACTS, "in-nutritional-information/3", "in-composition/2"],
  // Owner 2026-11-11: Canada reads India's composition lists; /3 adds Health Canada's medicinal-ingredient lines.
  "amazon.ca": [US_FACTS, "in-composition/3"],
  // Owner 2026-11-11: Germany reads US bottles, English (UK) sections in the UK's /3 and German labels in the EU format.
  "amazon.de": [US_FACTS, "in-nutritional-information/3", "eu-food-supplement/1"],
  // Owner 2026-11-13: Spain reads US bottles, English (UK) sections in the UK's /3 and Spanish labels in its own format
  // (the stickers' ES section is the enlarged one; "加西班牙文").
  "amazon.es": [US_FACTS, "in-nutritional-information/3", "es-food-supplement/1"],
};

/**
 * Whether the composition rules written for India's /2 lists apply (made-up-with lines, a list's 100% total, a
 * paragraph's amounts): /2 and every later version. /1 answers decode as they were read.
 */
export function readsCompositionRules(formats: readonly LabelFormatId[]): boolean {
  return formats.includes("in-composition/2") || formats.includes("in-composition/3");
}

/** The formats a label is read in: the US panel alone unless the task names more. */
export function labelFormatsOf(
  formats: readonly LabelFormatId[] | undefined,
): readonly LabelFormatId[] {
  return formats?.length ? formats : [US_FACTS];
}

/** Whether these are exactly the US formats, read with every rule as it was before formats existed. */
export function isUsOnlyFormats(formats: readonly LabelFormatId[] | undefined): boolean {
  const read = labelFormatsOf(formats);
  return read.length === 1 && read[0] === US_FACTS;
}

/** The value-column role of a printed header in these formats, or null when it names none. */
export function columnRole(header: string, formats: readonly LabelFormatId[]): ColumnRole | null {
  const text = header.replace(/\s+/gu, " ").trim();
  for (const format of formats) {
    const { columns } = LABEL_FORMATS[format];
    const dv = columns.dailyValue.find(({ header: pattern }) => pattern.test(text));
    if (dv) return { role: "daily_value", basis: dv.basis, format };
    if (columns.perBasis.some((pattern) => pattern.test(text)))
      return { role: "per_basis", format };
    if (columns.amount.some((pattern) => pattern.test(text))) return { role: "amount", format };
  }
  return null;
}
export type ColumnRole = { format: LabelFormatId } & (
  { role: "amount" } | { role: "per_basis" } | { role: "daily_value"; basis: DailyValueBasis }
);

/** Every rule of one kind across these formats, US rules excluded (they are the parser's own). */
export function formatRules<
  K extends "headerCells" | "skip" | "servings" | "servingFor" | "preparedFrom" | "continuation",
>(formats: readonly LabelFormatId[], kind: K): readonly RegExp[] {
  return formats.filter((id) => id !== US_FACTS).flatMap((id) => LABEL_FORMATS[id][kind] ?? []);
}
