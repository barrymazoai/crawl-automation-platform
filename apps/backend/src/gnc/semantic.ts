import { PRODUCT_FORMS, extractLastJsonArray, type ProductForm } from "../amazon/semantic-clean.js";

export interface GncCleanInput {
  sku: string;
  title: string;
  description: string | null;
  details: string;
  labelText: string | null;
  labelIngredients: string[];
}

export interface GncCleanResult {
  sku: string;
  healthFunctions: string[];
  productForm: ProductForm;
  ingredients: string[];
  scopeDecision: "included" | "excluded";
  scopeReason: "nutrition_product" | "non_nutrition_product" | "bundle_or_pack" | "ingredients_and_formula_missing" | "nutrition_evidence_missing";
  scopeEvidence: string[];
}

/** 混合套装的信号：不同产品/口味装在一起。命中即真套装。 */
const VARIETY_PATTERN = /\b(variety|assorted|assortment|sampler|mix(?:ed)?[- ]?(?:pack|box|case)|mix[- ]and[- ]match|bundle|kit|stack|starter[- ]?(?:set|pack)|gift[- ]?(?:set|box)|combo|duo|trio)\b|\s\+\s/i;
/** 数量装的信号：同一产品装 N 份。 */
const QUANTITY_PACK_PATTERN = /\b(\d+)\s*[-x×]?\s*(?:pack|pk|count|ct|cans?|bottles?|cartons?|bars?|servings?)\b|\bcase\s+of\s+\d+\b|\b\d+\s*x\s*\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|oz|ml|g)\b/i;

/**
 * 同一产品的数量装（12-Pack、Case of 24、4 x 8 oz）不是套装。这个判断交给模型不稳（liveowyn 121 个变体
 * 里先 75 后 36 个仍被判 bundle），所以在 prompt 里逐条给确定性提示：命中数量装且无混合信号 → PACK_HINT。
 */
export function packHint(title: string, variantText?: string | null) {
  const text = `${title} ${variantText ?? ""}`;
  if (VARIETY_PATTERN.test(text)) return "variety_or_mixed";
  if (QUANTITY_PACK_PATTERN.test(text)) return "quantity_pack";
  return null;
}

export function buildGncBatchPrompt(inputs: GncCleanInput[], vocabulary: string[]) {
  const blocks = inputs.map((input) => [
    `### SKU ${input.sku}`,
    `TITLE: ${input.title.slice(0, 240)}`,
    ...(packHint(input.title) === "quantity_pack" ? ["PACK_HINT: multi-unit quantity pack of ONE identical product — this is NOT a bundle; never use bundle_or_pack for this SKU"] : []),
    ...(packHint(input.title) === "variety_or_mixed" ? ["PACK_HINT: mixed/variety pack of different products or flavors — bundle_or_pack"] : []),
    `DESCRIPTION: ${(input.description ?? "").slice(0, 1000)}`,
    `DETAILS: ${input.details.slice(0, 1600)}`,
    `LABEL_TEXT: ${(input.labelText ?? "").slice(0, 5000)}`,
    `LABEL_INGREDIENTS: ${input.labelIngredients.join(" | ").slice(0, 2500)}`,
  ].join("\n")).join("\n\n");
  return `You are normalizing GNC catalog data for a HUMAN NUTRITION database. Process each SKU independently; variants are separate products.

Rules:
- Include only one sellable human oral nutrition product. Exclude bundles/kits, topical products, devices, pet products, and records without positive formula evidence.
- bundle_or_pack means the listing combines DIFFERENT products or flavors: variety pack, assorted, mix-and-match, sampler, stack, kit, set, starter/gift set, "A + B". A multi-unit quantity pack of ONE identical product (12-Pack, Case of 24, 4 x 8 oz cartons, twin-pack, 3-count of the same item) is NOT a bundle: treat it as a pack-size variant of that product and include it when formula evidence exists. When a SKU carries PACK_HINT, follow it.
- LABEL_TEXT and LABEL_INGREDIENTS come from that exact SKU's official GNC Ingredients HTML table, or its PDF/OCR fallback, and are the strongest formula evidence.
- scope_reason must be one of nutrition_product, non_nutrition_product, bundle_or_pack, ingredients_and_formula_missing, nutrition_evidence_missing.
- scope_evidence must contain 1-5 short excerpts copied from the supplied fields. Never invent evidence.
- health_functions: choose 1-4 values only from ALLOWED health_functions. Prefer explicit function/benefit claims in DETAILS, TITLE, and DESCRIPTION; never infer a function from an ingredient alone.
- product_form: one of ${PRODUCT_FORMS.join("/")}.
- ingredients: return individual active/formula ingredient names grounded in LABEL_INGREDIENTS or LABEL_TEXT. Do not include amounts, Daily Value, warnings, or directions.

Return only one JSON array, in input order:
[{"sku":string,"scope_decision":"included"|"excluded","scope_reason":string,"scope_evidence":string[],"health_functions":string[],"product_form":string,"ingredients":string[]}]

ALLOWED health_functions:
${vocabulary.join(" | ")}

${blocks}`;
}

export function parseGncBatchOutput(raw: string, expected: GncCleanInput[], vocabulary: string[]) {
  const problems: string[] = [];
  const parsed = extractLastJsonArray(raw);
  if (!parsed) return { results: [] as GncCleanResult[], problems: ["输出里没有可解析的 JSON 数组"] };
  const wanted = new Map(expected.map((item) => [item.sku, item]));
  const vocab = new Set(vocabulary);
  const forms = new Set<string>(PRODUCT_FORMS);
  const reasons = new Set<GncCleanResult["scopeReason"]>(["nutrition_product", "non_nutrition_product", "bundle_or_pack", "ingredients_and_formula_missing", "nutrition_evidence_missing"]);
  const bySku = new Map<string, GncCleanResult>();
  for (const value of parsed) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const sku = String(row.sku ?? "").trim();
    const input = wanted.get(sku);
    if (!input) { if (sku) problems.push(`结果里出现了本批没送过的 SKU：${sku}`); continue; }
    const healthFunctions = [...new Set((Array.isArray(row.health_functions) ? row.health_functions : []).map(String).map((item) => item.trim()).filter((item) => {
      if (vocab.has(item)) return true;
      if (item) problems.push(`${sku}: 词表外功效「${item}」已丢弃`);
      return false;
    }))];
    const suppliedIngredients = (Array.isArray(row.ingredients) ? row.ingredients : []).map(String).map((item) => item.trim()).filter(Boolean);
    const ingredients = [...new Set(suppliedIngredients.length ? suppliedIngredients : input.labelIngredients)];
    let scopeDecision: "included" | "excluded" = row.scope_decision === "included" ? "included" : "excluded";
    let scopeReason = reasons.has(String(row.scope_reason) as GncCleanResult["scopeReason"])
      ? String(row.scope_reason) as GncCleanResult["scopeReason"] : "nutrition_evidence_missing";
    const scopeEvidence = (Array.isArray(row.scope_evidence) ? row.scope_evidence : []).map(String).map((item) => item.trim()).filter(Boolean).slice(0, 5);
    if (scopeDecision === "included" && ingredients.length === 0) { scopeDecision = "excluded"; scopeReason = "ingredients_and_formula_missing"; }
    if (scopeDecision === "included" && scopeEvidence.length === 0) { scopeDecision = "excluded"; scopeReason = "nutrition_evidence_missing"; }
    if (scopeDecision === "included") scopeReason = "nutrition_product";
    bySku.set(sku, {
      sku,
      healthFunctions,
      productForm: forms.has(String(row.product_form)) ? String(row.product_form) as ProductForm : "other",
      ingredients,
      scopeDecision,
      scopeReason,
      scopeEvidence,
    });
  }
  for (const input of expected) if (!bySku.has(input.sku)) problems.push(`${input.sku}: 模型没有返回结果`);
  return { results: expected.map((input) => bySku.get(input.sku)).filter((value): value is GncCleanResult => Boolean(value)), problems };
}
