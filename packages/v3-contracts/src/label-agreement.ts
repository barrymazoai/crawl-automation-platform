import { dequal } from "dequal";
import type { labelFormulaStructure, LabelCandidate } from "./label-extraction.js";
import { hasConfirmedNoOtherIngredients } from "./label-ingredient-declaration.js";
import { labelNameForComparison, labelTypographyStructure } from "./label-typography.js";
import { sameServingSize } from "./label-rules/serving-size.js";
type Formula = NonNullable<ReturnType<typeof labelFormulaStructure>> & {
  wording?: (string | null)[];
};
type Row = Formula["columns"][number]["rows"][number];
type FormulaInput = Formula | NonNullable<LabelCandidate["formula"]>;
export type LabelAgreement = "exact" | "wording" | "conflict";
export type FormulaAgreement = LabelAgreement | "subset";
type Comparison = "label-typography/1" | "label-typography/2";
const fieldText = (value: string | { text: string } | null) =>
  typeof value === "string" ? value : (value?.text ?? null);
/** Accept raw candidate fields as well as comparison projections; citations are not wording. */
function formulaText(formula: FormulaInput): Formula {
  const { drugFacts, ...base } = formula;
  return {
    ...base,
    ...(drugFacts ? { drugFacts: fieldText(drugFacts) } : {}),
    servingSize: fieldText(formula.servingSize),
    servingsPerContainer: fieldText(formula.servingsPerContainer),
    columns: formula.columns.map((column) => ({
      heading: fieldText(column.heading),
      rows: column.rows.map(({ purpose, ...row }) => ({
        ...row,
        ...(purpose ? { purpose: fieldText(purpose) } : {}),
        name: fieldText(row.name),
        amount: fieldText(row.amount),
        dailyValue: fieldText(row.dailyValue),
      })),
    })),
  };
}

export const labelAgreementIngredients = (candidate: LabelCandidate) =>
  candidate.otherIngredients?.items.map((item) => item.text) ??
  (hasConfirmedNoOtherIngredients(candidate) ? [] : null);

/** Retain original wording for warnings without rewriting source values. */
export const labelAgreementFormula = (candidate: LabelCandidate, comparison?: Comparison) => {
  if (!candidate.formula) {
    return null;
  }
  const original = formulaText(candidate.formula);
  if (!comparison) {
    return original;
  }
  const wording = original.columns.flatMap((column) => [
    column.heading,
    ...column.rows.flatMap((row) => [row.name, row.amount, row.dailyValue]),
  ]);
  return {
    ...original,
    ...labelTypographyStructure(candidate, comparison),
    servingSize: original.servingSize,
    servingsPerContainer: original.servingsPerContainer,
    wording,
  };
};

const text = (value: string) => value.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();
const name = (value: string) =>
  text(value.normalize("NFKC").replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"'))
    .replace(/(\d)\s*(?=(?:mcg|[µμ]g|mg|g|iu)\b)/gu, "$1 ")
    .replace(/\bd\s*[-‐‑‒–—]\s*3\b/gu, "d3")
    .replace(/[\p{P}\s]+/gu, " ")
    .trim();

// Preserve decimal/fraction/range punctuation and unit signs while collapsing cosmetic punctuation.
const metadataText = (value: string) =>
  text(
    text(value).replace(
      /((?<=\d)[.,:/–—-](?=\d)|[-−](?=\d)|[%/])|\p{P}/gu,
      (_mark, numeric: string | undefined) => numeric ?? " ",
    ),
  );

/** Missing metadata is incomplete evidence, not a disagreement or an instruction to fill it in. */
export function labelMetadataAgreement(left: string | null, right: string | null): LabelAgreement {
  const agrees = left === null || right === null || metadataText(left) === metadataText(right);
  return left === right ? "exact" : agrees ? "wording" : "conflict";
}

/** Spelling only: never convert doses, round numbers, or remove comparison/footnote symbols. */
function measure(value: string | null): string | null {
  return value === null
    ? null
    : text(value.normalize("NFKC").replace(/(?<=\d),(?=\d{3}(?:\D|$))/gu, ""))
        .replace(/[.,;:!?]+$/gu, "")
        .replace(/\s*\(\s*/gu, " (")
        .replace(/\s*\)\s*/gu, ") ")
        .replace(/(\d)\s*(?=[a-zµμ])/gu, "$1 ")
        .replace(/(?<![\p{L}\p{N}])(?:micrograms?|[µμu]g)\b/gu, "mcg")
        .replace(/\bmilligrams?\b/gu, "mg")
        .replace(/\bkilograms?\b/gu, "kg")
        .replace(/\bgrams?\b/gu, "g")
        .replace(/\bmillilit(?:er|re)s?\b/gu, "ml")
        .replace(/\blit(?:er|re)s?\b/gu, "l")
        .replace(/\binternational units?\b/gu, "iu")
        .replace(/(\d)\s*%/gu, "$1%")
        .trim();
}

const formulaName = (value: string | null) => value === null ? null :
  ingredientWordingKey(value).replace(/(\d)\s*(?=(?:mcg|[µμ]g|mg|g|iu)\b)/gu, "$1 ");
const formulaMeasure = (value: string | null) => measure(value)?.replace(/[†*]+/gu, "*") ?? null;
const formulaMetadata = (left: string | null, right: string | null, serving = false) =>
  left === null || right === null ||
  (serving && sameServingSize(left, right)) ||
  labelMetadataAgreement(left, right) !== "conflict";

export const formulaComparisonSize = (formula: FormulaInput | null): number =>
  formula?.columns.reduce((sum, column) => sum + column.rows.length, 0) ?? 0;

/** Prefer a verified complete reading, then the reading with more retained rows. */
export function preferFormulaSource(current: LabelCandidate, next: LabelCandidate): boolean {
  const quality = (candidate: LabelCandidate) => Number(candidate.formulaComplete && candidate.issues.length === 0);
  return quality(next) > quality(current) ||
    quality(next) === quality(current) &&
    formulaComparisonSize(next.formula) > formulaComparisonSize(current.formula);
}

function sourceClause(value: string) {
  const match = text(value).match(/^([^()]+)\(\s*(?:as|from)\s+([^()]+)\)\s*$/u);
  if (!match) {
    return null;
  }
  return {
    base: name(match[1] ?? ""),
    words: name(match[2] ?? "")
      .split(" ")
      .filter(Boolean),
  };
}

function namesAgree(left: string | null, right: string | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (formulaName(left) === formulaName(right) || name(left) === name(right)) {
    return true;
  }
  const first = sourceClause(left);
  const second = sourceClause(right);
  if (!first?.words.length || !second?.words.length || first.base !== second.base) {
    return false;
  }
  return (
    first.words.every((word) => second.words.includes(word)) ||
    second.words.every((word) => first.words.includes(word))
  );
}

function orderedAgreement<Value>(
  left: Value[],
  right: Value[],
  agrees: (first: Value, second: Value) => boolean,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => right[index] !== undefined && agrees(value, right[index]))
  );
}

function rowsAgree(left: Row, right: Row): boolean {
  const { name: first, amount: firstAmount, dailyValue: firstDaily, ...firstStructure } = left;
  const { name: second, amount: secondAmount, dailyValue: secondDaily, ...secondStructure } = right;
  return (
    dequal(firstStructure, secondStructure) &&
    namesAgree(first, second) &&
    formulaMeasure(firstAmount) === formulaMeasure(secondAmount) &&
    formulaMeasure(firstDaily)?.replace(/\s/gu, "") === formulaMeasure(secondDaily)?.replace(/\s/gu, "")
  );
}

function subsetRows(shorter: Row[], longer: Row[]): boolean {
  let index = 0;
  for (const row of longer) {
    if (shorter[index] && rowsAgreeWithoutParent(shorter[index]!, row)) index++;
  }
  return index === shorter.length;
}

function rowsAgreeWithoutParent(left: Row, right: Row): boolean {
  return rowsAgree({ ...left, parentRowIndex: null }, { ...right, parentRowIndex: null });
}

function repeatedMaterial(rows: Row[]): boolean {
  const keys = rows.map(row => `${row.kind}:${name(row.name ?? "")}`);
  return new Set(keys).size !== keys.length;
}

function columnRelation(left: Formula["columns"][number], right: Formula["columns"][number]) {
  if (!formulaMetadata(left.heading, right.heading)) return "conflict";
  if (orderedAgreement(left.rows, right.rows, rowsAgree)) return "wording";
  const first = left.rows.filter(row => row.kind !== "group_header");
  const second = right.rows.filter(row => row.kind !== "group_header");
  const groupsA = left.rows.filter(row => row.kind === "group_header");
  const groupsB = right.rows.filter(row => row.kind === "group_header");
  if (repeatedMaterial(first) || repeatedMaterial(second) ||
      first.length === second.length && groupsA.length === groupsB.length) return "conflict";
  const groupsMatch = subsetRows(groupsA, groupsB) || subsetRows(groupsB, groupsA);
  const materialSubset = subsetRows(first, second) || subsetRows(second, first);
  return groupsMatch && materialSubset ? "subset" : "conflict";
}

function normalizedFormula(formula: Formula) {
  return {
    servingSize: formula.servingSize && metadataText(formula.servingSize),
    servingsPerContainer: formula.servingsPerContainer && metadataText(formula.servingsPerContainer),
    columns: formula.columns.map(column => ({
      heading: column.heading && formulaName(column.heading),
      rows: column.rows.map(row => [row.kind, formulaName(row.name),
        formulaMeasure(row.amount), formulaMeasure(row.dailyValue)]),
    })),
  };
}

/** Ordered formula comparison; metadata and all row coordinates retain their existing meaning. */
export function formulaAgreement(
  left: FormulaInput | null,
  right: FormulaInput | null,
): FormulaAgreement {
  if (!left || !right) {
    return left === right ? "exact" : "conflict";
  }
  const first = formulaText(left);
  const second = formulaText(right);
  if (dequal(first, second)) {
    return "exact";
  }
  const compatible =
    !!first.drugFacts === !!second.drugFacts &&
    formulaMetadata(first.servingSize, second.servingSize, true) &&
    formulaMetadata(first.servingsPerContainer, second.servingsPerContainer) &&
    first.columns.length === second.columns.length;
  if (!compatible) return "conflict";
  const relations = first.columns.map((column, index) =>
    columnRelation(column, second.columns[index]!));
  if (relations.includes("conflict")) return "conflict";
  if (relations.includes("subset")) return "subset";
  return dequal(normalizedFormula(first), normalizedFormula(second)) ? "exact" : "wording";
}

/** Review-only normalized comparison shape; original fields remain in provenance. */
export function formulaConflictDetails(
  sources: { id: string; candidate: Pick<LabelCandidate, "formula"> }[],
) {
  return [{
    code: "LABEL_PRODUCT.FORMULA_CONFLICT",
    sources: sources.flatMap(({ id, candidate }) => {
      const formula = candidate.formula && formulaText(candidate.formula);
      return formula ? [{ id, shape: normalizedFormula(formula) }] : [];
    }),
  }];
}

const ingredient = (value: string) =>
  text(value).replace(
    /^(?:contains (?:2\s*% or less|less(?: than 2\s*%)?)|less than 2\s*%) of\b\s*:?\s*/u,
    "",
  );

/**
 * One ingredient item for comparison only (never stored): case, spacing, ™/® and footnote marks (*, †, ‡, §) and
 * punctuation around the item do not change it. Owner 2026-10-09 (CRAWLV3-214): "Dry Roasted Almonds" on the page
 * and "DRY ROASTED ALMONDS." on the label are one item.
 */
export function ingredientWordingKey(value: string): string {
  return ingredient(labelNameForComparison(value.replace(/[™®]/gu, "").normalize("NFKC").replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"')))
    .replace(/\s*\(\s*/gu, " (")
    .replace(/\s*\)\s*/gu, ") ")
    .replace(/\s*(?:&|\band\b)\s*/gu, " and ")
    .replace(/(?<=^|[\s(,;:])[*†‡§]+|[*†‡§]+(?=$|[\s),.;:!?])/gu, "")
    .replace(/^[\s.,;:!?]+|[\s.,;:!?]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

const ingredientShape = (items: string[]) => items
  .map(item => ingredientWordingKey(item.replace(/\bcontains\s*:\s*.*$/iu, "")))
  .filter(Boolean);
export const ingredientComparisonSize = (items: string[]) => new Set(ingredientShape(items)).size;

function conjunctionSegmentation(left: string[], right: string[]): boolean {
  if (left.length + 1 !== right.length) return false;
  return left.some((item, index) => {
    const parts = item.split(/\s+and\s+/u);
    if (parts.length !== 2 || parts.some(part => !part)) return false;
    const expanded = [...left.slice(0, index), ...parts, ...left.slice(index + 1)];
    return dequal(expanded, right);
  });
}

export type IngredientRelation = "exact" | "wording" | "reordered" | "subset" | "conflict";
/** Compare lists without changing the printed values. Only exact item keys can be a subset. */
export function ingredientListRelation(left: string[] | null, right: string[] | null): IngredientRelation {
  if (dequal(left, right)) return "exact";
  if (left === null || right === null) return "conflict";
  if (left.length === 0 || right.length === 0) return "conflict";
  const first = ingredientShape(left), second = ingredientShape(right);
  if (!first.length || !second.length) return "conflict";
  if (dequal(first, second)) return "wording";
  if (conjunctionSegmentation(first, second) || conjunctionSegmentation(second, first)) return "wording";
  const setA = new Set(first), setB = new Set(second);
  if (setA.size === setB.size && [...setA].every(item => setB.has(item))) return "reordered";
  if (setA.size < setB.size && [...setA].every(item => setB.has(item)) ||
      setB.size < setA.size && [...setB].every(item => setA.has(item))) return "subset";
  return "conflict";
}

const botanicalOrPart = /\(\s*(?:[A-Z][a-z]+\s+[a-z]+(?:\s+[a-z]+)?|(?:root|leaf|bark|seed|fruit|flower|rhizome))\s*\)/gu;
const formWord = /\b(?:extract|powder|dried)\b/gu;

function activeNameKey(value: string): string {
  return ingredientWordingKey(value.replace(botanicalOrPart, " "))
    .replace(formWord, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function matchesFormulaRow(item: string, rowName: string): boolean {
  const exact = ingredientWordingKey(item) === ingredientWordingKey(rowName);
  const itemKey = activeNameKey(item);
  return exact || (itemKey.length > 0 && itemKey === activeNameKey(rowName));
}

export const isFullIngredientsHeading = (heading: string | null | undefined): boolean =>
  heading !== null && heading !== undefined && /^ingredients\s*:?$/iu.test(heading.trim());

/** A page's full ingredient list may include named formula rows before its excipients. */
export function pageIngredientsIncludeActives(
  imageItems: string[] | null,
  pageItems: string[] | null,
  formulaNames: string[],
): boolean {
  if (!imageItems?.length || !pageItems?.length || !formulaNames.length) return false;
  const remaining = pageItems.filter(item => !formulaNames.some(name => matchesFormulaRow(item, name)));
  if (remaining.length === pageItems.length || !remaining.length) return false;
  const imageKeys = new Set(ingredientShape(imageItems));
  const pageKeys = new Set(ingredientShape(remaining));
  return imageKeys.size > 0 && [...imageKeys].every(key => pageKeys.has(key));
}

/** Review-only diagnostic; the assembly wire result and source wording stay unchanged. */
export function ingredientConflictDetails(
  sources: { id: string; candidate: { otherIngredients?: { items: { text: string }[] } | null } }[],
) {
  return [{
    code: "LABEL_PRODUCT.INGREDIENTS_CONFLICT",
    sources: sources.flatMap(source => {
      const items = source.candidate.otherIngredients?.items.map(item => item.text);
      return items ? [{ id: source.id, items, shape: ingredientShape(items) }] : [];
    }),
  }];
}

/** Only a leading low-percentage qualifier is ignored; item boundaries and order stay intact. */
export function ingredientsAgreement(
  left: string[] | null,
  right: string[] | null,
  // The comparison version once chose whether ™/® counted; wording never makes a conflict (owner 2026-10-09).
  _comparison?: Comparison,
): LabelAgreement {
  const relation = ingredientListRelation(left, right);
  return relation === "exact" ? "exact" : relation === "conflict" ? "conflict" : "wording";
}
