import { z } from "zod";
import { assessLabelGroups } from "./label-groups.js";

/** New opt-in extraction protocol; never reinterpret a legacy candidate as this codec. */
export const labelExtractionVersion = "label-extraction/1" as const;
export const labelValidationVersion = "label-validation/1" as const;
const content = z.string().min(1).max(20000).regex(/\S/u);
export const LabelAnchorSchema = z.strictObject({ fromLine: z.number().int().positive(), toLine: z.number().int().positive(), text: content });
export const LabelQuoteSchema = z.strictObject({ text: content, start: z.number().int().nonnegative(), end: z.number().int().positive().max(200000) });
export const LabelImageFieldSchema = z.strictObject({ text: content, evidence: content });

/** The field codec changes with the evidence medium; the formula structure does not. */
export function labelExtractionSchema<F extends z.ZodType>(field: F) {
  const row = z.strictObject({
    kind: z.enum(["nutrient", "group_header", "blend_total", "blend_component"]),
    name: field, amount: field.nullable(), dailyValue: field.nullable(),
    amountStatus: z.enum(["printed", "not_declared", "unreadable", "not_applicable"]),
    // Zero-based index within THIS column, not a name or a global ingredient id.
    parentRowIndex: z.number().int().nonnegative().nullable(),
  });
  return z.strictObject({ codec: z.literal(labelExtractionVersion),
    formula: z.strictObject({ servingSize: field.nullable(), servingsPerContainer: field.nullable(),
      columns: z.array(z.strictObject({ heading: field.nullable(), rows: z.array(row).min(1).max(200) })).min(1).max(8),
    }).nullable(),
    otherIngredients: z.strictObject({ heading: field, items: z.array(field).min(1).max(300) }).nullable(),
    formulaComplete: z.boolean(), ingredientsComplete: z.boolean(),
    exclusions: z.array(z.strictObject({ quote: field, reason: z.enum(["heading", "footnote", "allergen", "directions", "metadata", "marketing", "noise"]) })).max(500),
    issues: z.array(z.strictObject({ code: z.enum(["UNREADABLE", "AMBIGUOUS", "FORMULA_MISSING", "INGREDIENTS_MISSING", "METADATA_CONFLICT"]), detail: z.string().min(1).max(4000) })).max(100),
  });
}
export const LabelTextWireSchema = labelExtractionSchema(LabelAnchorSchema);
export const LabelTextCandidateSchema = labelExtractionSchema(LabelQuoteSchema);
export const LabelImageCandidateSchema = labelExtractionSchema(LabelImageFieldSchema);
export type LabelTextCandidate = z.infer<typeof LabelTextCandidateSchema>;
export type LabelImageCandidate = z.infer<typeof LabelImageCandidateSchema>;
export type LabelCandidate = LabelTextCandidate | LabelImageCandidate;

/** Structural/quality checks, NOT source verification or product-ingestion approval. */
/** Real labels head the ingredient list many ways ("Other Ingredients:", "Ingredients:", "Inactive Ingredients",
 * "Capsule ingredients:; Other ingredients:", OCR "Oher"). Accept any heading naming ingredients; reject facts-table
 * headings and warnings, which is what this rule exists for. */
export function isIngredientHeading(raw: string): boolean {
  const text = raw.trim();
  if (!/\b(?:ingredients?|ingr[e\.]{0,2}dients?|oher\s+ingredients)\b/i.test(text)) return false;
  if (/\b(?:supplement|nutrition)\s+facts\b|amount\s+per\s+serving|daily\s+value|contains\s*:|may\s+contain|allergen/i.test(text)) return false;
  return text.length <= 80;
}
/** The rule that fired and where: row index and printed name, or the section concerned. */
export type LabelFinding = { code: string; detail: string };
export function assessLabelCandidate(candidate: LabelCandidate) {
  const codes = new Set<string>(), findings: LabelFinding[] = [];
  const warnings: LabelFinding[] = [];
  // Every code keeps the first place that raised it, so a Review can say which row broke which rule.
  const flag = (code: string, detail: string) => { if (!codes.has(code)) findings.push({ code, detail }); codes.add(code); };
  const rowText = (row: { name: { text: string }; amount: { text: string } | null }, index: number) =>
    `row ${index} "${row.name.text.slice(0, 80)}"${row.amount ? ` amount "${row.amount.text.slice(0, 30)}"` : ""}`;
  let componentCount = 0;
  for (const column of candidate.formula?.columns ?? []) {
    const groups = assessLabelGroups(column.rows);
    groups.findings.forEach(finding => flag(finding.code, finding.detail));
    warnings.push(...groups.warnings);
    column.rows.forEach((row, index) => {
      if ((row.amountStatus === "printed") !== (row.amount !== null)) flag("LABEL.AMOUNT_STATE_CONFLICT", `${rowText(row, index)}: status ${row.amountStatus} but amount ${row.amount ? "present" : "missing"}`);
      if (row.kind === "group_header") {
        if (row.amountStatus !== "not_applicable" || row.amount !== null || row.dailyValue !== null) flag("LABEL.HEADER_VALUE_CONFLICT", `${rowText(row, index)}: a group header carries a value`);
      } else if (row.amountStatus === "not_applicable") flag("LABEL.AMOUNT_STATE_CONFLICT", `${rowText(row, index)}: ${row.kind} marked not_applicable${row.dailyValue ? ` (label prints only %DV "${row.dailyValue.text}")` : ""}`);
      if (row.amountStatus === "unreadable") flag("LABEL.AMOUNT_UNREADABLE", `${rowText(row, index)}: amount unreadable`);
      if (row.kind === "blend_component") {
        componentCount++;
        const parent = row.parentRowIndex === null ? undefined : column.rows[row.parentRowIndex];
        // A declared blend total may legitimately omit individual component amounts.
        if (row.amountStatus === "not_declared" && parent?.kind !== "blend_total") flag("LABEL.AMOUNT_MISSING", `${rowText(row, index)}: component without amount outside a blend total`);
      } else {
        if (row.kind !== "group_header" && row.amountStatus === "not_declared") flag("LABEL.AMOUNT_MISSING", `${rowText(row, index)}: no amount${row.dailyValue ? ` (label prints only %DV "${row.dailyValue.text}")` : ""}`);
      }
    });
  }
  const hasIngredients = componentCount > 0 || !!candidate.otherIngredients;
  if (candidate.otherIngredients) {
    if (!isIngredientHeading(candidate.otherIngredients.heading.text)) flag("LABEL.INGREDIENT_HEADING_INVALID", `ingredient heading "${candidate.otherIngredients.heading.text.slice(0, 80)}" is not an ingredients heading`);
    if (candidate.otherIngredients.items.some(i => /\b(?:contains\s*:|may\s+contain|manufactured\s+(?:in|on)|shared\s+equipment)/i.test(i.text))) flag("LABEL.INGREDIENT_ROLE_INVALID", "an ingredient item is an allergen/manufacturing statement");
  }
  if (!candidate.formula && candidate.formulaComplete || !hasIngredients && candidate.ingredientsComplete) flag("LABEL.COMPLETENESS_CONFLICT", "marked complete with nothing extracted");
  if (candidate.formula && (!candidate.formula.servingSize || !candidate.formulaComplete)) flag("LABEL.FORMULA_INCOMPLETE", !candidate.formula.servingSize ? "formula has no serving size" : "model marked the formula incomplete");
  if (hasIngredients && !candidate.ingredientsComplete) flag("LABEL.INGREDIENTS_INCOMPLETE", candidate.otherIngredients ? "model marked the ingredient list incomplete" : "only blend components, no Other Ingredients list");
  const uncertain = candidate.issues.find(i => ["UNREADABLE", "AMBIGUOUS", "METADATA_CONFLICT"].includes(i.code));
  if (uncertain) flag("LABEL.EVIDENCE_UNCERTAIN", `model reported ${uncertain.code}${"detail" in uncertain && uncertain.detail ? `: ${String(uncertain.detail).slice(0, 160)}` : ""}`);
  if (candidate.formula && candidate.issues.some(i => i.code === "FORMULA_MISSING") ||
      hasIngredients && candidate.issues.some(i => i.code === "INGREDIENTS_MISSING")) flag("LABEL.COMPLETENESS_CONFLICT", "extracted content contradicts a reported missing section");
  if (!candidate.formula && !hasIngredients) flag("LABEL.CORE_MISSING", `no formula and no ingredients${candidate.issues[0] && "detail" in candidate.issues[0] && candidate.issues[0].detail ? `; model: ${String(candidate.issues[0].detail).slice(0, 160)}` : ""}`);
  return { status: codes.size ? "review" as const : candidate.formula && hasIngredients ? "candidate" as const : "partial" as const,
    codes: [...codes], findings, warnings };
}

/** Small projection for structural comparison; group identity is never the printed name. */
export function labelFormulaStructure(candidate: LabelCandidate) {
  const text = (f: { text: string } | null) => f?.text.replace(/\s+/gu, " ").trim() ?? null;
  return candidate.formula ? { servingSize: text(candidate.formula.servingSize),
    servingsPerContainer: text(candidate.formula.servingsPerContainer), columns: candidate.formula.columns.map(c => ({
      heading: text(c.heading), rows: c.rows.map(r => ({ kind: r.kind, name: text(r.name), amount: text(r.amount),
        amountStatus: r.amountStatus, dailyValue: text(r.dailyValue), parentRowIndex: r.parentRowIndex })),
    })) } : null;
}
