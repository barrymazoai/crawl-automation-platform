import { ProductResolvedEvidenceManifestSchema, ProductFormulaSchema, ProductIngredientSchema, TextRecordSchema, TextCandidateV2Schema,
  VisionRecordSchema, VisionCandidateSchema, assertTextQuotes, type ProductEvidenceManifest, type TextRecord, type TextCandidate,
  type VisionRecord, type VisionCandidate, type ProductFormula, type ProductField, type ProductIngredient } from "@crawl-automation/v3-contracts";
import { isDeepStrictEqual as equal } from "node:util";
export type VerifiedProductEvidence = { id: string } & ({ kind: "text"; record: TextRecord; candidate: TextCandidate; fullText: string } |
  { kind: "image"; record: VisionRecord; candidate: VisionCandidate });
const name = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const words = (s: string) => s.replace(/\s+/g, " ").trim();
const sort = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const semantic = (f: ProductField | null) => f ? words(f.text) : null;
function project(e: VerifiedProductEvidence) {
  if (e.kind === "image") {
    const c = VisionCandidateSchema.parse(e.candidate);
    const field = (f: { text: string; evidence: string } | null): ProductField | null => f ? { text: f.text, citations: [{ kind: "image", sourceId: e.id, evidence: f.evidence }] } : null;
    return { formula: c.formula ? { servingSize: field(c.formula.servingSize), servingsPerContainer: field(c.formula.servingsPerContainer),
      columns: c.formula.columns.map(col => ({ heading: col.heading, nutrients: col.nutrients.map(n => ({ name: field(n.name)!, amount: field(n.amount), dailyValue: field(n.dailyValue) })) })) } : null,
      ingredients: c.ingredients.map(i => ({ name: field({ text: i.name, evidence: i.evidence })!, role: i.role, parentBlend: i.parentBlend })),
      codes: [...(c.issues.some(i => ["UNREADABLE", "AMBIGUOUS"].includes(i.code)) ? ["VALIDATION.EVIDENCE_UNCERTAIN"] : []),
        ...(c.formula && !c.formulaComplete ? ["VALIDATION.FORMULA_INCOMPLETE"] : []),
        ...(c.ingredients.length && !c.ingredientsComplete ? ["VALIDATION.INGREDIENTS_INCOMPLETE"] : [])] };
  }
  const c = TextCandidateV2Schema.parse(e.candidate), input = e.record.input;
  if (input.source.kind !== "prepared" || input.resultSchemaVersion !== 2 || input.range.start !== 0 || input.range.end !== e.fullText.length)
    throw Error("MIXED.TEXT_SCOPE_UNVERIFIED");
  assertTextQuotes(c, input, e.fullText);
  const field = (q: { text: string; start: number; end: number } | null): ProductField | null => q ? { text: q.text,
    citations: [{ kind: "text", sourceId: e.id, text: q.text, start: q.start, end: q.end }] } : null;
  return { formula: c.formula ? { servingSize: field(c.formula.servingSize), servingsPerContainer: null,
    columns: [{ heading: null, nutrients: c.formula.nutrients.map(n => ({ name: field(n.name)!, amount: field(n.amount), dailyValue: field(n.dailyValue) })) }] } : null,
    ingredients: (c.ingredients?.items ?? []).map(i => ({ name: field(i)!, role: i.role,
      parentBlend: i.parentNutrientIndex === null ? null : c.formula!.nutrients[i.parentNutrientIndex]!.name.text })), codes: [] as string[] };
}
const combineField = (a: ProductField | null, b: ProductField | null) => {
  if (!a || !b) return;
  const seen = new Set(a.citations.map(c => JSON.stringify(c)));
  for (const c of b.citations) if (!seen.has(JSON.stringify(c))) { a.citations.push(c); seen.add(JSON.stringify(c)); }
};
/** Pure merge of fully verified, closed-manifest evidence. No I/O or model/normalization guesses. */
export function mergeProductEvidence(raw: ProductEvidenceManifest, rawEntries: VerifiedProductEvidence[], failures: { id: string; code: string }[] = []) {
  const manifest = ProductResolvedEvidenceManifestSchema.parse(raw), codes = new Set<string>(), warnings: { id: string; code: string }[] = [];
  const entries = [...rawEntries].sort((a, b) => sort(a.id, b.id)), seen = new Set<string>();
  const sources = new Map(manifest.sources.map(s => [s.id, s]));
  const fail = (id: string, code: string) => { if (sources.get(id)!.required) codes.add(code); else warnings.push({ id, code }); };
  for (const f of failures) {
    if (!sources.has(f.id) || seen.has(f.id)) throw Error("MIXED.IDENTITY_CONFLICT");
    seen.add(f.id); fail(f.id, f.code);
  }
  let formula: ProductFormula | null = null;
  const groups = new Map<string, ProductIngredient[]>(), provenance: { id: string; kind: "text" | "image"; record: TextRecord | VisionRecord }[] = [];
  for (const e of entries) {
    const source = sources.get(e.id);
    if (!source || source.kind !== e.kind || seen.has(e.id)) throw Error("MIXED.IDENTITY_CONFLICT");
    seen.add(e.id);
    if (e.kind === "text") {
      const record = TextRecordSchema.parse(e.record);
      if (!equal(record.input, source.task)) throw Error("MIXED.IDENTITY_CONFLICT");
    } else {
      const record = VisionRecordSchema.parse(e.record);
      if (!equal({ input: record.input, configFingerprint: record.configFingerprint }, source.task)) throw Error("MIXED.IDENTITY_CONFLICT");
    }
    const c = project(e);
    provenance.push({ id: e.id, kind: e.kind, record: e.record });
    if (c.codes.length) { c.codes.forEach(code => fail(e.id, code)); continue; }
    if (c.formula) {
      if (!formula) formula = structuredClone(c.formula);
      else {
        const a = formula, b = c.formula;
        const body = (f: ProductFormula) => ({ servingSize: semantic(f.servingSize), columns: f.columns.map(col => col.nutrients.map(n => [semantic(n.name), semantic(n.amount), semantic(n.dailyValue)])) });
        // V2 text has no column-heading field: only a single otherwise identical column can align.
        if (!equal(body(a), body(b)) || a.columns.some((col, i) => col.heading !== null && b.columns[i]?.heading !== null && words(col.heading) !== words(b.columns[i]?.heading ?? "")))
          codes.add("VALIDATION.FORMULA_CONFLICT");
        else {
          combineField(a.servingSize, b.servingSize);
          a.columns.forEach((col, i) => { col.heading ??= b.columns[i]!.heading; col.nutrients.forEach((n, j) => {
            const other = b.columns[i]!.nutrients[j]!; combineField(n.name, other.name); combineField(n.amount, other.amount); combineField(n.dailyValue, other.dailyValue);
          }); });
          // Container count is optional metadata, never silently overwrite disagreement.
          if (a.servingsPerContainer && b.servingsPerContainer && semantic(a.servingsPerContainer) !== semantic(b.servingsPerContainer))
            warnings.push({ id: e.id, code: "VALIDATION.CONTAINER_COUNT_CONFLICT" });
          else { if (!a.servingsPerContainer) a.servingsPerContainer = b.servingsPerContainer; else combineField(a.servingsPerContainer, b.servingsPerContainer); }
        }
      }
    }
    const own = new Map<string, ProductIngredient[]>();
    for (const i of c.ingredients) {
      const key = JSON.stringify([i.role, i.parentBlend === null ? null : name(i.parentBlend)]);
      own.set(key, [...(own.get(key) ?? []), i]);
    }
    for (const [group, values] of own) {
      const items = [...values].sort((a, b) => sort(name(a.name.text), name(b.name.text)));
      if (new Set(items.map(i => name(i.name.text))).size !== items.length) { codes.add("VALIDATION.INGREDIENTS_DUPLICATE"); continue; }
      const prior = groups.get(group);
      if (!prior) groups.set(group, structuredClone(items));
      else if (!equal(prior.map(i => name(i.name.text)), items.map(i => name(i.name.text)))) codes.add("VALIDATION.INGREDIENTS_CONFLICT");
      else prior.forEach((i, n) => combineField(i.name, items[n]!.name));
    }
  }
  if (seen.size !== sources.size) codes.add("MIXED.BARRIER_INCOMPLETE");
  const ingredients = [...groups.entries()].sort(([a], [b]) => sort(a, b)).flatMap(([, v]) => v);
  if (!formula) codes.add("VALIDATION.FORMULA_MISSING");
  if (!ingredients.length) codes.add("VALIDATION.INGREDIENTS_MISSING");
  const parents = new Set(formula?.columns.flatMap(c => c.nutrients.map(n => name(n.name.text))) ?? []);
  if (ingredients.some(i => i.role === "other" ? i.parentBlend !== null : i.parentBlend === null || !parents.has(name(i.parentBlend)))) codes.add("VALIDATION.INGREDIENT_PARENT_CONFLICT");
  if (formula) formula = ProductFormulaSchema.parse(formula);
  ingredients.forEach(i => ProductIngredientSchema.parse(i));
  return { schemaVersion: 1 as const, codec: "product-evidence/1" as const, status: codes.size ? "review" as const : "ready" as const,
    codes: [...codes].sort(), warnings: warnings.sort((a, b) => sort(a.id, b.id) || sort(a.code, b.code)), formula, ingredients, provenance };
}
