import { ProductImageManifestSchema, VisionCandidateSchema, VisionRecordSchema,
  type ProductImageManifest, type VisionRecord, type VisionCandidate } from "@crawl-automation/v3-contracts";
export type VerifiedImageCandidate = { record: VisionRecord; candidate: VisionCandidate };
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
// Compare semantic fields, not evidence wording. Never normalize quantities/units or merge dosage columns.
const value = (v: unknown): unknown => typeof v === "string" ? v.replace(/\s+/g, " ").trim() : Array.isArray(v) ? v.map(value)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "evidence").map(([k, x]) => [k, value(x)])) : v;
const key = (v: unknown) => JSON.stringify(value(v));
/** Pure, deterministic image-path assembly. Inputs must be resolved by the verified-evidence adapter. */
export function mergeProductImages(raw: ProductImageManifest, rawEntries: VerifiedImageCandidate[]) {
  const manifest = ProductImageManifestSchema.parse(raw), ids = new Set<string>(), codes = new Set<string>();
  const entries = rawEntries.map(e => ({ record: VisionRecordSchema.parse(e.record), candidate: VisionCandidateSchema.parse(e.candidate) }))
    .sort((a, b) => a.record.input.selection.image.artifactId < b.record.input.selection.image.artifactId ? -1 :
      a.record.input.selection.image.artifactId > b.record.input.selection.image.artifactId ? 1 : 0);
  for (const { record } of entries) {
    const s = record.input.selection, id = s.image.artifactId;
    if (JSON.stringify(s.observation) !== JSON.stringify(manifest.observation) || !manifest.imageIds.includes(id) || ids.has(id) || record.configFingerprint !== manifest.configFingerprint)
      throw Error("PRODUCT.IDENTITY_CONFLICT");
    ids.add(id);
  }
  let formula: VisionCandidate["formula"] = null;
  const groups = new Map<string, VisionCandidate["ingredients"]>();
  for (const { candidate: c } of entries) {
    if (c.issues.some(i => i.code === "UNREADABLE" || i.code === "AMBIGUOUS")) codes.add("VALIDATION.EVIDENCE_UNCERTAIN");
    if (c.formula) {
      if (!c.formulaComplete) codes.add("VALIDATION.FORMULA_INCOMPLETE");
      if (formula && key(formula) !== key(c.formula)) codes.add("VALIDATION.FORMULA_CONFLICT");
      formula ??= c.formula;
    }
    if (c.ingredients.length) {
      if (!c.ingredientsComplete) codes.add("VALIDATION.INGREDIENTS_INCOMPLETE");
      const own = new Map<string, VisionCandidate["ingredients"]>();
      for (const i of c.ingredients) {
        const group = JSON.stringify([i.role, i.parentBlend === null ? null : normalize(i.parentBlend)]);
        own.set(group, [...(own.get(group) ?? []), i]);
      }
      for (const [group, items] of own) {
        if (groups.has(group) && key(groups.get(group)) !== key(items)) codes.add("VALIDATION.INGREDIENTS_CONFLICT");
        if (!groups.has(group)) groups.set(group, items);
      }
    }
  }
  const ingredients = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([, items]) => items);
  if (!formula) codes.add("VALIDATION.FORMULA_MISSING");
  if (!ingredients.length) codes.add("VALIDATION.INGREDIENTS_MISSING");
  const parents = new Set(formula?.columns.flatMap(c => c.nutrients.map(n => normalize(n.name.text))) ?? []);
  if (ingredients.some(i => i.role === "other" ? i.parentBlend !== null : i.parentBlend === null || !parents.has(normalize(i.parentBlend))))
    codes.add("VALIDATION.INGREDIENT_PARENT_CONFLICT");
  return { status: codes.size ? "review" as const : "ready" as const, codes: [...codes].sort(), formula, ingredients,
    // Preserve all contributing image/result refs; don't fabricate OCR offsets for visual evidence.
    provenance: entries.map(e => ({ image: e.record.input.selection.image, result: e.record.result })) };
}
