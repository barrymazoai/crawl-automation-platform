import { isDeepStrictEqual as equal } from "node:util";
import { LabelProductManifestSchema, LabelImageCandidateSchema, TextCandidateV3Schema, TextRecordSchema, VisionRecordSchema,
  LabelProductProvenanceSchema, projectLabelProductCandidate, assessLabelCandidate, labelFormulaStructure, assertTextQuotes, isCompleteLabelImage, isCompleteLabelText,
  type LabelProductManifest, type LabelCollectedProduct, type LabelImageCandidate,
  labelTypographyStructure, labelNameForComparison, labelImageIntegrityCodes, labelNumericSourceConflict, PackagingFactsSchema, type PackagingFacts, type TextRecord, type TextCandidateV3, type VisionRecord } from "@crawl-automation/v3-contracts";
export type VerifiedLabelSource = { id: string } & ({ kind: "text"; record: TextRecord; candidate: TextCandidateV3; fullText: string } |
  { kind: "image"; record: VisionRecord; candidate: LabelImageCandidate });
const words = (s: string) => s.replace(/\s+/gu, " ").trim();
const sort = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** No I/O. Readers must reverify registered original evidence, not just trust receipts. */
export function mergeLabelProduct(raw: LabelProductManifest, entries: VerifiedLabelSource[], failures: { id: string; code: string; verifiedExecuted?: boolean }[] = [], packaging?: PackagingFacts) {
  const manifest = LabelProductManifestSchema.parse(raw), sources = new Map(manifest.sources.map(s => [s.id, s]));
  const seen = new Set<string>(), codes = new Set<string>(), warnings: { id: string; code: string }[] = [];
  const provenance: LabelCollectedProduct["provenance"] = [];
  const counts = new Set<string>();
  if (!!manifest.admission !== !!packaging) throw Error("LABEL_PRODUCT.PACKAGING_UNVERIFIED");
  if (packaging) {
    packaging = PackagingFactsSchema.parse(packaging);
    if (!equal(packaging.observation, manifest.observation)) throw Error("LABEL_PRODUCT.IDENTITY_CONFLICT");
    packaging.warnings.forEach(code => warnings.push({ id: manifest.operationId, code }));
    packaging.servingsPerContainer.claims.forEach(c => counts.add(words(c.value)));
  }
  let formula: LabelCollectedProduct["formula"] | null = null, otherIngredients: LabelCollectedProduct["otherIngredients"] = null;
  let formulaShape: ReturnType<typeof labelFormulaStructure> = null, otherShape: string[] | null = null;
  const fail = (id: string, code: string) => { if (sources.get(id)!.required) codes.add(code); else warnings.push({ id, code }); };
  for (const failure of failures) {
    if (!sources.has(failure.id) || seen.has(failure.id)) throw Error("LABEL_PRODUCT.IDENTITY_CONFLICT");
    seen.add(failure.id);
  }
  for (const e of [...entries].sort((a, b) => sort(a.id, b.id))) {
    const source = sources.get(e.id);
    if (!source || source.kind !== e.kind || seen.has(e.id)) throw Error("LABEL_PRODUCT.IDENTITY_CONFLICT");
    seen.add(e.id);
    if (e.kind === "text") {
      if (!equal(TextRecordSchema.parse(e.record).input, source.task)) throw Error("LABEL_PRODUCT.IDENTITY_CONFLICT");
    } else if (!equal({ input: VisionRecordSchema.parse(e.record).input, configFingerprint: e.record.configFingerprint }, source.task)) throw Error("LABEL_PRODUCT.IDENTITY_CONFLICT");
    const c = e.kind === "text" ? TextCandidateV3Schema.parse(e.candidate) : LabelImageCandidateSchema.parse(e.candidate);
    // Verify every text quote, including exclusions, against the full prepared document.
    if (e.kind === "text") {
      if (e.record.input.range.start !== 0 || e.record.input.range.end !== e.fullText.length) throw Error("LABEL_PRODUCT.TEXT_SCOPE_UNVERIFIED");
      assertTextQuotes(TextCandidateV3Schema.parse(c), e.record.input, e.fullText);
    }
    provenance.push(e.kind === "text" ? { id: e.id, kind: "text", record: e.record, candidate: TextCandidateV3Schema.parse(c) }
      : { id: e.id, kind: "image", record: e.record, candidate: LabelImageCandidateSchema.parse(c) });
  }
  // Verify ALL sources first. Priority must never bypass identity, citations or required barriers.
  const quality = ["label-image-first/4", "label-image-first/5"].includes(manifest.evidencePolicy??"");
  const integrity = (p: typeof provenance[number]) => quality && p.kind === "image" ? labelImageIntegrityCodes(p.candidate) : [];
  const eligible = provenance.filter(p => !integrity(p).length);
  const imageFirst = !!manifest.evidencePolicy && eligible.some(isCompleteLabelImage);
  const textFallback = ["label-image-first/3","label-image-first/4","label-image-first/5"].includes(manifest.evidencePolicy??"") && !imageFirst && eligible.some(isCompleteLabelText);
  if(manifest.evidencePolicy === "label-image-first/4" && labelNumericSourceConflict(eligible))codes.add("LABEL_PRODUCT.SOURCE_NUMERIC_CONFLICT");
  if(textFallback)warnings.push({id:manifest.operationId,code:"LABEL_PRODUCT.COMPLETE_TEXT_FALLBACK"});
  for (const failure of failures) {
    // /1 keeps its required-source barrier. /2 permits only an already-verified
    // text quality Review to be secondary to a COMPLETE verified image. Unknown
    // execution, missing receipts, identity failures and failed images still block.
    if (["label-image-first/2","label-image-first/3","label-image-first/4","label-image-first/5"].includes(manifest.evidencePolicy??"") && imageFirst && failure.verifiedExecuted===true && sources.get(failure.id)!.kind === "text" &&
      (manifest.evidencePolicy === "label-image-first/5" && failure.code === "TEXT.CITATION_INVALID" || /^TEXT\.LABEL_(?:GROUP_EMPTY|GROUP_INVALID|ROW_ORDER_INVALID|COVERAGE_UNCERTAIN|EXTRACTION_INCOMPLETE|FORMULA_INCOMPLETE|INGREDIENTS_INCOMPLETE|INVALID_OUTPUT|INGREDIENT_BOUNDARY)$/.test(failure.code)))
      warnings.push({ id: failure.id, code: failure.code });
    else if(textFallback && failure.verifiedExecuted===true && sources.get(failure.id)!.kind==="image" &&
      (/^VISION\.LABEL_(?:INGREDIENTS_INCOMPLETE|FORMULA_INCOMPLETE|AMOUNT_UNREADABLE|CORE_MISSING|EVIDENCE_UNCERTAIN)$/.test(failure.code) || quality && /^VISION\.LABEL_(?:AMOUNT_EVIDENCE_CONFLICT|INGREDIENT_BOUNDARY)$/.test(failure.code)))warnings.push({id:failure.id,code:failure.code});
    else fail(failure.id, failure.code);
  }
  packaging?.blockingIssues.forEach(code => {
    if (imageFirst) warnings.push({ id: manifest.operationId, code });
    else codes.add(code);
  });
  const priority = (p: typeof provenance[number]) => !imageFirst ? 0 : isCompleteLabelImage(p) ? 0 : p.kind === "image" ? 1 : 2;
  for (const e of [...provenance].sort((a, b) => priority(a) - priority(b) || sort(a.id, b.id))) {
    const integrityCodes=integrity(e);
    if(integrityCodes.length){
      if(textFallback)integrityCodes.forEach(code=>warnings.push({id:e.id,code}));
      else integrityCodes.forEach(code=>fail(e.id,code));
      continue;
    }
    const c = e.candidate, secondaryText = imageFirst && e.kind === "text";
    const assessed = assessLabelCandidate(c);
    if(textFallback&&e.kind==="image"){
      // Keep original partial evidence; never mix unreadable image rows into the
      // complete textual label or bypass a malformed image structure.
      if(assessed.codes.some(code=>!["LABEL.INGREDIENTS_INCOMPLETE","LABEL.FORMULA_INCOMPLETE","LABEL.AMOUNT_UNREADABLE","LABEL.CORE_MISSING","LABEL.EVIDENCE_UNCERTAIN"].includes(code)))assessed.codes.forEach(code=>fail(e.id,code));
      else warnings.push({id:e.id,code:"LABEL_PRODUCT.INCOMPLETE_IMAGE_NOT_SELECTED"});
      continue;
    }
    if (assessed.status === "review") { assessed.codes.forEach(code => fail(e.id, code)); continue; }
    const projected = projectLabelProductCandidate(e.id, c);
    if (c.formula) {
      const shape = (manifest.admission?.comparison ? labelTypographyStructure(c, manifest.admission.comparison) : labelFormulaStructure(c))!;
      if (packaging) {
        if (shape.servingsPerContainer) counts.add(shape.servingsPerContainer);
        // Count per package is not a per-serving dose. Keep original values in provenance.
        shape.servingsPerContainer = null;
        if (packaging.servingSize.value && shape.servingSize !== words(packaging.servingSize.value)) {
          if (imageFirst) warnings.push({ id: e.id, code: "PACKAGING.SERVING_SIZE_CONFLICT" });
          else codes.add("PACKAGING.SERVING_SIZE_CONFLICT");
        }
      }
      if (formulaShape && !equal(formulaShape, shape)) {
        if (secondaryText) warnings.push({ id: e.id, code: "LABEL_PRODUCT.SECONDARY_TEXT_FORMULA_CONFLICT" });
        else codes.add("LABEL_PRODUCT.FORMULA_CONFLICT");
      }
      if (!formula && !secondaryText) {
        formulaShape = shape;
        formula = projected.formula;
      }
    }
    if (c.otherIngredients) {
      const shape = c.otherIngredients.items.map(i => manifest.admission?.comparison ? labelNameForComparison(i.text) : words(i.text));
      if ((otherShape || secondaryText) && !equal(otherShape, shape)) {
        if (secondaryText) warnings.push({ id: e.id, code: "LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT" });
        else codes.add("LABEL_PRODUCT.INGREDIENTS_CONFLICT");
      }
      if (!otherIngredients && !secondaryText) {
        otherShape = shape; otherIngredients = projected.otherIngredients;
      }
    }
  }
  if (seen.size !== sources.size) codes.add("LABEL_PRODUCT.BARRIER_INCOMPLETE");
  const ingredients: LabelCollectedProduct["ingredients"] = (formula?.columns ?? []).flatMap((col, columnIndex) => col.rows.flatMap((row, rowIndex) =>
    row.kind === "blend_component" ? [{ name: row.name, role: "blend_component" as const, amount: row.amount, columnIndex, rowIndex, parentRowIndex: row.parentRowIndex }] : []));
  ingredients.push(...(otherIngredients?.items ?? []).map(name => ({ name, role: "other" as const, amount: null, columnIndex: null, rowIndex: null, parentRowIndex: null })));
  if (!formula) codes.add("VALIDATION.FORMULA_MISSING");
  if (!ingredients.length) codes.add("VALIDATION.INGREDIENTS_MISSING");
  if (packaging && counts.size > 1) {
    if (formula) formula.servingsPerContainer = null;
    if (!warnings.some(w => w.code === "PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT")) warnings.push({ id: manifest.operationId, code: "PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT" });
  }
  return { codec: packaging ? "label-product-assembly/2" as const : "label-product-assembly/1" as const,
    ...(manifest.evidencePolicy ? { evidencePolicy: manifest.evidencePolicy } : {}),
    ...(packaging ? { admissionPolicy: "label-packaging/1" as const, ...(manifest.admission?.comparison ? { comparisonPolicy: manifest.admission.comparison } : {}), packaging } : {}), status: codes.size ? "review" as const : "ready" as const,
    codes: [...codes].sort(), warnings: warnings.sort((a, b) => sort(a.id, b.id) || sort(a.code, b.code)), formula, otherIngredients, ingredients,
    provenance: provenance.map(p => LabelProductProvenanceSchema.parse(p)) };
}
