import { z } from "zod";
import { drugFactsHeading, drugActiveHeading, drugInactiveHeading } from "./label-drug.js";
import { LabelIngredientDeclarationSchema } from "./label-ingredient-declaration.js";
import { hasConfirmedNoOtherIngredients, ingredientDeclarationIncomplete } from "./label-ingredient-declaration.js";
import { assessLabelRows } from "./label-row-assessment.js";
export { hasConfirmedNoOtherIngredients } from "./label-ingredient-declaration.js";

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
    // Drug Facts Purpose is quoted like every other value; old rows omit this field.
    purpose: field.nullable().optional(),
    amountStatus: z.enum(["printed", "not_declared", "unreadable", "not_applicable"]),
    // Zero-based index within THIS column, not a name or a global ingredient id.
    parentRowIndex: z.number().int().nonnegative().nullable(),
  });
  // A cited Drug Facts heading opts into drug validation; absent means existing serving rules.
  return z.strictObject({ codec: z.literal(labelExtractionVersion),
    // Absent or null for Supplement/Nutrition Facts (the model's strict format sends null).
    formula: z.strictObject({ drugFacts: field.nullable().optional(), servingSize: field.nullable(), servingsPerContainer: field.nullable(),
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
export const LabelImageCandidateSchema = labelExtractionSchema(LabelImageFieldSchema).extend({
  ingredientDeclaration: LabelIngredientDeclarationSchema.optional(),
});
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
  if (/\b(?:supplement|nutrition|drug)\s+facts\b|amount\s+per\s+serving|daily\s+value|contains\s*:|may\s+contain|allergen/i.test(text)) return false;
  return text.length <= 80;
}
/** The rule that fired and where: row index and printed name, or the section concerned. */
export type LabelFinding = { code: string; detail: string };
export function assessLabelCandidate(candidate: LabelCandidate) {
  const codes = new Set<string>(), findings: LabelFinding[] = [];
  const warnings: LabelFinding[] = [];
  // Every code keeps the first place that raised it, so a Review can say which row broke which rule.
  const flag = (code: string, detail: string) => { if (!codes.has(code)) findings.push({ code, detail }); codes.add(code); };
  let componentCount = 0;
  for (const column of candidate.formula?.columns ?? []) {
    const rows = assessLabelRows(column.rows);
    rows.findings.forEach(finding => flag(finding.code, finding.detail));
    warnings.push(...rows.warnings);
    componentCount += column.rows.filter(row => row.kind === "blend_component").length;
  }
  const hasIngredients = componentCount > 0 || !!candidate.otherIngredients || hasConfirmedNoOtherIngredients(candidate);
  if (ingredientDeclarationIncomplete(candidate)) flag("LABEL.INGREDIENTS_INCOMPLETE", "no complete printed list or enabled whole-label absence declaration");
  if (candidate.otherIngredients) {
    if (!isIngredientHeading(candidate.otherIngredients.heading.text)) flag("LABEL.INGREDIENT_HEADING_INVALID", `ingredient heading "${candidate.otherIngredients.heading.text.slice(0, 80)}" is not an ingredients heading`);
    if (candidate.otherIngredients.items.some(i => /\b(?:contains\s*:|may\s+contain|manufactured\s+(?:in|on)|shared\s+equipment)/i.test(i.text))) flag("LABEL.INGREDIENT_ROLE_INVALID", "an ingredient item is an allergen/manufacturing statement");
  }
  if (!candidate.formula && candidate.formulaComplete || !hasIngredients && candidate.ingredientsComplete) flag("LABEL.COMPLETENESS_CONFLICT", "marked complete with nothing extracted");
  if (candidate.formula?.drugFacts && !validDrugFormula(candidate)) flag("LABEL.FORMULA_INCOMPLETE", "Drug Facts requires its heading, active ingredient columns and inactive ingredients");
  if (candidate.formula && ((!candidate.formula.servingSize && !candidate.formula.drugFacts) || !candidate.formulaComplete)) flag("LABEL.FORMULA_INCOMPLETE", !candidate.formula.servingSize ? "formula has no serving size" : "model marked the formula incomplete");
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
  return candidate.formula ? { ...(candidate.formula.drugFacts ? { drugFacts: text(candidate.formula.drugFacts) } : {}), servingSize: text(candidate.formula.servingSize),
    servingsPerContainer: text(candidate.formula.servingsPerContainer), columns: candidate.formula.columns.map(c => ({
      heading: text(c.heading), rows: c.rows.map(r => ({ kind: r.kind, name: text(r.name), amount: text(r.amount),
        ...(r.purpose ? { purpose: text(r.purpose) } : {}),
        amountStatus: r.amountStatus, dailyValue: text(r.dailyValue), parentRowIndex: r.parentRowIndex })),
    })) } : null;
}

/** Drug Facts is an explicit cited panel, never inferred from missing serving metadata. */
function validDrugFormula(candidate: LabelCandidate): boolean {
  const formula = candidate.formula;
  return !!formula?.drugFacts && drugFactsHeading.test(formula.drugFacts.text) &&
    !!candidate.otherIngredients && drugInactiveHeading.test(candidate.otherIngredients.heading.text) &&
    formula.columns.every(column => !!column.heading && drugActiveHeading.test(column.heading.text) &&
      column.rows.every(row => row.kind === "nutrient" && row.parentRowIndex === null && row.dailyValue === null));
}

/** Freeze historical model output formats; optional contract additions must not alter old prompts. */
export function legacyLabelExtractionSchema<F extends z.ZodType>(field: F) {
  const schema = labelExtractionSchema(field);
  const formula = schema.shape.formula.unwrap();
  const column = formula.shape.columns.element;
  return schema.extend({ formula: formula.omit({ drugFacts: true }).extend({
    columns: z.array(column.extend({ rows: z.array(column.shape.rows.element.omit({ purpose: true })).min(1).max(200) })).min(1).max(8),
  }).nullable() });
}
