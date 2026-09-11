import { z } from "zod";

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
export function assessLabelCandidate(candidate: LabelCandidate) {
  const codes = new Set<string>();
  let componentCount = 0;
  for (const column of candidate.formula?.columns ?? []) {
    let activeGroup: number | null = null;
    column.rows.forEach((row, index) => {
      if ((row.amountStatus === "printed") !== (row.amount !== null)) codes.add("LABEL.AMOUNT_STATE_CONFLICT");
      if (row.kind === "group_header") {
        if (row.amountStatus !== "not_applicable" || row.amount !== null || row.dailyValue !== null) codes.add("LABEL.HEADER_VALUE_CONFLICT");
      } else if (row.amountStatus === "not_applicable") codes.add("LABEL.AMOUNT_STATE_CONFLICT");
      if (row.amountStatus === "unreadable") codes.add("LABEL.AMOUNT_UNREADABLE");
      if (row.kind === "blend_component") {
        componentCount++;
        const parent = row.parentRowIndex === null ? undefined : column.rows[row.parentRowIndex];
        if (row.parentRowIndex === null || row.parentRowIndex >= index || row.parentRowIndex !== activeGroup ||
            !parent || !["group_header", "blend_total"].includes(parent.kind)) codes.add("LABEL.PARENT_INVALID");
        // A declared blend total may legitimately omit individual component amounts.
        if (row.amountStatus === "not_declared" && parent?.kind !== "blend_total") codes.add("LABEL.AMOUNT_MISSING");
      } else {
        if (row.parentRowIndex !== null) codes.add("LABEL.PARENT_INVALID");
        activeGroup = row.kind === "group_header" || row.kind === "blend_total" ? index : null;
        if (row.kind !== "group_header" && row.amountStatus === "not_declared") codes.add("LABEL.AMOUNT_MISSING");
      }
      if ((row.kind === "group_header" || row.kind === "blend_total") &&
          (column.rows[index + 1]?.kind !== "blend_component" || column.rows[index + 1]?.parentRowIndex !== index)) codes.add("LABEL.GROUP_EMPTY");
    });
  }
  const hasIngredients = componentCount > 0 || !!candidate.otherIngredients;
  if (candidate.otherIngredients) {
    if (!/^(?:other|oher)\s+ingredients\s*:?$/i.test(candidate.otherIngredients.heading.text.trim())) codes.add("LABEL.INGREDIENT_HEADING_INVALID");
    if (candidate.otherIngredients.items.some(i => /\b(?:contains\s*:|may\s+contain|manufactured\s+(?:in|on)|shared\s+equipment)/i.test(i.text))) codes.add("LABEL.INGREDIENT_ROLE_INVALID");
  }
  if (!candidate.formula && candidate.formulaComplete || !hasIngredients && candidate.ingredientsComplete) codes.add("LABEL.COMPLETENESS_CONFLICT");
  if (candidate.formula && (!candidate.formula.servingSize || !candidate.formulaComplete)) codes.add("LABEL.FORMULA_INCOMPLETE");
  if (hasIngredients && !candidate.ingredientsComplete) codes.add("LABEL.INGREDIENTS_INCOMPLETE");
  if (candidate.issues.some(i => ["UNREADABLE", "AMBIGUOUS", "METADATA_CONFLICT"].includes(i.code))) codes.add("LABEL.EVIDENCE_UNCERTAIN");
  if (candidate.formula && candidate.issues.some(i => i.code === "FORMULA_MISSING") ||
      hasIngredients && candidate.issues.some(i => i.code === "INGREDIENTS_MISSING")) codes.add("LABEL.COMPLETENESS_CONFLICT");
  if (!candidate.formula && !hasIngredients) codes.add("LABEL.CORE_MISSING");
  return { status: codes.size ? "review" as const : candidate.formula && hasIngredients ? "candidate" as const : "partial" as const,
    codes: [...codes] };
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
