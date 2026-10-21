import { dequal } from "dequal";
import type { labelFormulaStructure, LabelCandidate } from "./label-extraction.js";
import type { LabelCollectedProduct } from "./label-product.js";
import { hasConfirmedNoOtherIngredients } from "./label-ingredient-declaration.js";
import { labelNameForComparison, labelTypographyStructure } from "./label-typography.js";
import { sameServingSize } from "./label-rules/serving-size.js";
type Formula = NonNullable<ReturnType<typeof labelFormulaStructure>> & {
  wording?: (string | null)[];
};
type Row = Formula["columns"][number]["rows"][number];
type FormulaInput = Formula | NonNullable<LabelCandidate["formula"]> |
  NonNullable<LabelCollectedProduct["formula"]>;
export type LabelAgreement = "exact" | "wording" | "conflict";
export type FormulaAgreement = LabelAgreement | "subset" | "sections";
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

/** Prefer the reading with the most actual information, including untruncated names and DV cells. */
export function preferFormulaSource(current: LabelCandidate, next: LabelCandidate): boolean {
  const score = (candidate: LabelCandidate) => {
    const formula = candidate.formula;
    const rows = formula?.columns.flatMap(column => column.rows.map(row => ({
      name: row.name.text, amount: !!row.amount, dailyValue: !!row.dailyValue,
    }))) ?? [];
    return [Number(candidate.formulaComplete), rows.filter(row => row.amount).length,
      rows.filter(row => row.dailyValue).length,
      Number(!!formula?.servingSize) + Number(!!formula?.servingsPerContainer),
      rows.reduce((total, row) => total + row.name.length, 0), rows.length,
      -candidate.issues.length];
  };
  const first = score(current), second = score(next);
  return second.some((value, index) => value !== first[index] &&
    second.slice(0, index).every((earlier, at) => earlier === first[at]) && value > first[index]!);
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

const bareName = (value: string) => name(value.replace(/\([^)]*\)/gu, " "));
function rowNamesAlign(left: string | null, right: string | null): boolean {
  if (!left || !right) return left === right;
  if (namesAgree(left, right)) return true;
  const first = bareName(left), second = bareName(right);
  if (first === second) return true;
  const a = first.split(" "), b = second.split(" ");
  if (a.length === b.length) {
    const differences = a.filter((word, index) => word !== b[index]);
    return differences.length === 1 && a.every((word, index) =>
      word === b[index] || word.length >= 3 && b[index]!.length >= 3 &&
      (word.startsWith(b[index]!) || b[index]!.startsWith(word)));
  }
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  return shorter.length >= 4 && longer.length === shorter.length + 1 &&
    shorter.every((word, index) => word === longer[index + 1]) ||
    shorter.length >= 2 && shorter.every((word, index) => word === longer[index]) &&
    /^(?:standardized|supplying|providing|yielding|equivalent)$/u.test(longer[shorter.length] ?? "");
}

function parentName(row: Row, rows: Row[]): string | null {
  if (row.parentRowIndex === null) return null;
  const parent = rows[row.parentRowIndex];
  return parent?.kind === "blend_total" || parent?.kind === "group_header" ? parent.name : null;
}

function compatibleMaterial(left: Row, right: Row, first: Row[], second: Row[]): boolean {
  const kinds = [left.kind, right.kind];
  const mixedKind = left.kind !== right.kind &&
    kinds.every(kind => kind === "nutrient" || kind === "blend_component");
  if (left.kind !== right.kind && !mixedKind) return false;
  if (mixedKind) {
    const nutrient = left.kind === "nutrient" ? left : right;
    const component = left.kind === "blend_component" ? left : right;
    if (nutrient.parentRowIndex !== null || component.parentRowIndex === null) return false;
  }
  const firstParent = parentName(left, first), secondParent = parentName(right, second);
  if (!mixedKind && first.length === second.length && left.parentRowIndex !== right.parentRowIndex ||
    !mixedKind && firstParent && secondParent && !namesAgree(firstParent, secondParent)) return false;
  const missingAmount = left.amount === null && right.amount !== null &&
    (left.amountStatus === "unreadable" || left.amountStatus === "not_declared") &&
    right.amountStatus === "printed";
  if (left.amountStatus !== right.amountStatus && !missingAmount) return false;
  const sourceQualified = /\(\s*(?:as|from)\b/iu;
  if (left.kind === "nutrient" && right.kind === "nutrient" &&
    (sourceQualified.test(left.name ?? "") || sourceQualified.test(right.name ?? "")) &&
    !namesAgree(left.name, right.name)) return false;
  const firstDV = formulaMeasure(left.dailyValue)?.replace(/\s/gu, "");
  const secondDV = formulaMeasure(right.dailyValue)?.replace(/\s/gu, "");
  return rowNamesAlign(left.name, right.name) &&
    (missingAmount || formulaMeasure(left.amount) === formulaMeasure(right.amount)) &&
    (!firstDV || !secondDV || firstDV === secondDV ||
      firstDV.replace(/(?<=%)\*$/u, "") === secondDV.replace(/(?<=%)\*$/u, ""));
}

function splitComponentMatches(parts: Row[], whole: Row): boolean {
  if (whole.kind !== "blend_component" || whole.amount !== null ||
    whole.amountStatus !== "not_declared" ||
    parts.some(part => part.kind !== "blend_component" || part.amount !== null ||
      part.amountStatus !== "not_declared" || !part.name) ||
    !whole.name) return false;
  const fragments = parts.map(part => bareName(part.name!).replace(/\s/gu, ""));
  const target = bareName(whole.name).replace(/\s/gu, "");
  if (fragments.some(fragment => fragment.length < 3)) return false;
  const words = parts.flatMap(part => bareName(part.name!).split(" "));
  const targetWords = bareName(whole.name).split(" ");
  if (parts.length === 2 && words.length === targetWords.length + 1 &&
    words.some((word, index) => words.lastIndexOf(word) !== index &&
      dequal([...words.slice(0, index), ...words.slice(index + 1)], targetWords))) {
    return true;
  }
  if (!target.startsWith(fragments[0]!)) return false;
  let position = fragments[0]!.length;
  for (const fragment of fragments.slice(1)) {
    const next = target.indexOf(fragment, position);
    if (next < position || next - position > 12) return false;
    position = next + fragment.length;
  }
  return position === target.length || target.startsWith(fragments.at(-1)!, target.length - fragments.at(-1)!.length);
}

function coveredBy(shorter: Row[], longer: Row[], shortSource = shorter, longSource = longer): boolean {
  let index = 0;
  for (const row of longer) {
    if (index >= shorter.length) break;
    if (compatibleMaterial(shorter[index]!, row, shortSource, longSource)) { index++; continue; }
    const count = [3, 2].find(size =>
      index + size <= shorter.length && splitComponentMatches(shorter.slice(index, index + size), row));
    if (count) index += count;
  }
  return index === shorter.length;
}

function separateSections(left: Formula, right: Formula): boolean {
  if (left.drugFacts || right.drugFacts) return false;
  const quantified = (formula: Formula) => formula.columns.flatMap(column => column.rows)
    .filter(row => row.name && row.amount && row.kind !== "group_header");
  const first = quantified(left), second = quantified(right);
  return first.length > 0 && second.length > 0 &&
    !first.some(row => second.some(other => rowNamesAlign(row.name, other.name)));
}

function repeatedMaterial(rows: Row[]): boolean {
  const keys = rows.map(row => `${row.kind}:${name(row.name ?? "")}`);
  return new Set(keys).size !== keys.length;
}

function sharedDoseConflict(first: Row[], second: Row[]): boolean {
  return first.some(row => row.amount !== null && second.some(other =>
    other.amount !== null && rowNamesAlign(row.name, other.name) &&
    formulaMeasure(row.amount) !== formulaMeasure(other.amount)));
}

function columnRelation(left: Formula["columns"][number], right: Formula["columns"][number]) {
  const panelTitle = (value: string | null) => value !== null &&
    /^(?:supplement facts|amount per serving|typical amino acid profile(?: amount per serving)?)$/iu
      .test(text(value).replace(/[—–-]/gu, " ").replace(/\s+/gu, " "));
  if (!formulaMetadata(left.heading, right.heading) &&
    !(panelTitle(left.heading) && panelTitle(right.heading))) return "conflict";
  if (orderedAgreement(left.rows, right.rows, rowsAgree)) return "wording";
  const first = left.rows.filter(row => row.kind !== "group_header");
  const second = right.rows.filter(row => row.kind !== "group_header");
  if (sharedDoseConflict(first, second)) return "conflict";
  const groupsA = left.rows.filter(row => row.kind === "group_header");
  const groupsB = right.rows.filter(row => row.kind === "group_header");
  const missingPrinted = first.some((row, index) =>
    row.amount === null && second[index]?.amount !== null ||
    row.amount !== null && second[index]?.amount === null);
  if (first.length === second.length && !missingPrinted &&
    first.some((row, index) => row.kind !== second[index]?.kind)) return "conflict";
  const withoutDV = (rows: Row[]) => rows.map(({ dailyValue: _dailyValue, ...row }) => row);
  if (first.length === second.length && groupsA.length === groupsB.length &&
    dequal(withoutDV(first), withoutDV(second)) &&
    first.some((row, index) => !!row.dailyValue !== !!second[index]?.dailyValue)) return "conflict";
  if (repeatedMaterial(first) || repeatedMaterial(second)) return "conflict";
  const groupsMatch = groupsA.length === groupsB.length ?
    orderedAgreement(groupsA, groupsB, rowsAgreeWithoutParent) :
    subsetRows(groupsA, groupsB) || subsetRows(groupsB, groupsA);
  const materialSubset = coveredBy(first, second, left.rows, right.rows) ||
    coveredBy(second, first, right.rows, left.rows);
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
    first.columns.length > 0 && second.columns.length > 0;
  if (!compatible) return "conflict";
  const shorter = first.columns.length <= second.columns.length ? first : second;
  const longer = shorter === first ? second : first;
  if (longer.columns.slice(shorter.columns.length).some(column => !column.rows.length)) return "conflict";
  if (first.drugFacts && (first.columns.length !== second.columns.length ||
    !first.columns.every((column, index) =>
      orderedAgreement(column.rows, second.columns[index]!.rows, rowsAgree)))) return "conflict";
  if (first.columns.length === second.columns.length && separateSections(first, second)) return "sections";
  const relations = shorter.columns.map((column, index) =>
    columnRelation(column, longer.columns[index]!));
  if (relations.includes("conflict")) return "conflict";
  if (relations.includes("subset") || first.columns.length !== second.columns.length) return "subset";
  return dequal(normalizedFormula(first), normalizedFormula(second)) ? "exact" : "wording";
}

/** Join two verified sections without rewriting any quoted field or its source citation. */
export function joinFormulaSections<T extends {
  servingSize: unknown;
  servingsPerContainer: unknown;
  columns: { heading: unknown; rows: { parentRowIndex: number | null }[] }[];
}>(left: T, right: T): T {
  const first = left.servingSize ? left : right.servingSize ? right : left;
  const second = first === left ? right : left;
  return {
    ...first,
    servingSize: first.servingSize ?? second.servingSize,
    servingsPerContainer: first.servingsPerContainer ?? second.servingsPerContainer,
    columns: first.columns.map((column, index) => {
      const later = second.columns[index]!;
      const offset = column.rows.length;
      return { heading: column.heading ?? later.heading, rows: [
        ...column.rows,
        ...later.rows.map(row => ({ ...row, parentRowIndex:
          row.parentRowIndex === null ? null : row.parentRowIndex + offset })),
      ] };
    }),
  } as T;
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
