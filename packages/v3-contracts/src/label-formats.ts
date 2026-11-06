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
]);
export type LabelFormatId = z.infer<typeof LabelFormatIdSchema>;

/** The US Supplement / Nutrition Facts panel, which every label rule was written for. */
export const US_FACTS: LabelFormatId = "us-facts/1";

/** Whose recommended intake a printed percentage column is relative to. */
export type DailyValueBasis = "us_dv" | "in_rda";

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
  // amazon.in, 2026-11-06 (20 real labels, docs/plans/KAN-243-india-research.md §10.7): headers with a footnote mark in
  // front ("*%RDA", "#%RDA", "**%RDA Per Serve", "*% RDA Men"), "% Daily Values†*", "Each Serving Provides",
  // "Per 30ml"; serving lines inside the table ("Serve Size: 30ml", "Serv Size - 2.38 g (1 sachet) Servings per pack
  // - 30", "1 SERVING (1=1 TABLET)"); section headings ("VITAMINS^", "MINERALS"); "(Approximate Composition)";
  // a description line under its ingredient. Everything /1 reads, /2 reads the same way.
  "in-nutritional-information/2": {
    keywords: ["Nutritional Information", "Nutrition Information", "Nutritional Facts", "RDA"],
    columns: {
      amount: [
        /^(?:qty|quantity|amount)\.?\s*(?:\/|per)\s*(?:serving|serve|tablet|capsule|sachet|scoop|dose)s?\b.*$/i,
        /^per\s+(?:serving|serve|tablet|capsule|sachet|scoop|dose)s?\b.*$/i,
        /^each\s+(?:serving|serve|tablet|capsule|sachet|scoop|dose)s?\s+(?:provides|contains)\b.*$/i,
        /^per\s+(?!100\s*(?:g|gm|ml)\b)\d+(?:\.\d+)?\s*(?:g|gm|ml|mg)\b.*$/i,
      ],
      perBasis: [
        /^(?:(?:qty|quantity|amount)\.?\s*)?(?:\/|per)\s*100\s*(?:g|gm|ml)\b.*$/i,
        // "ENSURE® Powder (per 100 g)", "Powder (per 100 g)" (Abbott, 2026-11-06)
        /^.{0,60}\(\s*per\s*100\s*(?:g|gm|ml)\s*\)$/i,
      ],
      dailyValue: [
        // A leading footnote mark: "**%RDA Per Serve", "^%RDA Per Serve" (amazon.in copies, 2026-11-06).
        { header: /^[*#†‡^]*\s*%?\s*rda\b.*$/i, basis: "in_rda" },
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
      /^(?:vitamins?|minerals?|amino\s+acids?|others?|herbal\s+extracts?|botanicals?|probiotics?|antioxidants?)\s*[\^*#:]*$/i,
    ],
    servings: [
      /^(?:no\.?\s*of\s+)?servings?\s*per\s*(?:pack|bottle|jar|container)\s*[:\-–]?\s*(.*)$/i,
      /^no\.?\s*of\s+servings?\s*[:\-–]?\s*(.*)$/i,
    ],
    servingFor: [
      /^serv(?:e|ing)?\.?\s+size\s*[:\-–]?\s*(.+?)(?:\s+servings?\s+per\s+(?:pack|bottle|jar|container)\s*[:\-–]?\s*(.+))?$/i,
      /^(1\s+serving\s*\(.+\))$/i,
    ],
    continuation: [/^\(.+\)$/],
    preparedFrom: none,
    prompt: [
      'The label may print an Indian "Nutritional Information" table instead (columns such as "Qty./Serving", "Qty/100g", "%RDA"). Transcribe it the same way: one cell per printed column, and each %RDA cell exactly as printed even when it is a bare number ("100", "0.20") or "**".',
      '"columnHeaders": every column header as printed, left to right, including the name column\'s header (e.g. "Nutrients") when one is printed; "" for a column without a header.',
    ],
  },
  // Composition lists as /1; "Excipients q.s." is the filler, not a formula row (Kapiva Shilajit, 2026-11-06).
  "in-composition/2": {
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
  },
};

/** The formats a storefront's labels are read in. A storefront not listed is not read at all. */
export const MARKETPLACE_LABEL_FORMATS: Readonly<Record<string, readonly LabelFormatId[]>> = {
  "amazon.com": [US_FACTS],
  // Owner 2026-11-06: /2 reads the table wording of the first 20 real amazon.in labels; /1 stays for its answers.
  "amazon.in": [US_FACTS, "in-nutritional-information/2", "in-composition/2"],
};

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
