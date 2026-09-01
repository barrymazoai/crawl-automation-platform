import { z } from "zod";
import { extractLastJsonArray } from "./amazon/semantic-clean.js";

export const PRODUCT_VARIANT_KEYS = [
  "flavor",
  "size",
  "servings",
  "pack",
  "strength",
  "edition",
  "form",
] as const;

export const CANONICAL_VARIANT_FORMS = [
  "capsule",
  "tablet",
  "softgel",
  "gummy",
  "chewable",
  "powder",
  "liquid",
  "oil",
  "spray",
  "lozenge",
  "stick_pack",
  "sachet",
  "soft_chew",
  "tea",
  "bar",
  "pellet",
  "gel",
  "cream",
] as const;

const cleanText = z.string().trim().min(1).max(300);
const positiveInteger = z.number().int().positive();
const quantityValue = z.object({ value: z.number().positive(), unit: cleanText.max(40) }).strict();

export const productVariantSchema = z.object({
  flavor: cleanText.optional(),
  size: z.union([
    cleanText,
    quantityValue,
  ]).optional(),
  servings: z.union([positiveInteger, cleanText]).optional(),
  pack: z.union([positiveInteger, cleanText]).optional(),
  strength: z.union([cleanText, quantityValue]).optional(),
  edition: cleanText.optional(),
  form: z.enum(CANONICAL_VARIANT_FORMS).optional(),
}).strict();

export type ProductVariant = z.infer<typeof productVariantSchema>;

export interface ProductUnifyInput {
  clientRef: string;
  channel: string;
  titleRaw: string;
  brand: string | null;
  /** 已经从渠道结构化字段确定映射到 strict variant 的值。模型不得改写。 */
  structuredVariant: ProductVariant;
  /** 渠道原文证据。这里允许 upc/category 等非 strict variant 字段。 */
  attrsRaw: Record<string, unknown>;
  /** 上一个语义阶段给出的剂型；只作为提示，不冒充渠道结构化字段。 */
  productFormHint?: string | null;
  /**
   * 同一产品线（变体家族）的稳定标识，来自站点自身而非模型：
   * GNC 的 family.parentExternalId、Amazon 的 parentAsin、Swanson 的 familyParentId、
   * 产品库里的 family_id 都可以填。
   *
   * 填了它，兄弟变体一定会进同一次模型调用——模型能看到"它们彼此差在哪"，
   * 才判断得出哪部分是产品线名、哪部分是变体维度。缺了这个上下文，模型面对孤立
   * 一条时会把 Extra Strength 这类修饰词当成变体（或反之），并因为无法可靠隔离
   * 产品线而返回 null base_name。
   */
  familyKey?: string | null;
}

export interface ProductUnifyResult {
  clientRef: string;
  productName: string;
  baseName: string | null;
  variant: ProductVariant;
  variantConfidence: number;
  variantSource: "ai_extract" | "channel_attrs";
  attrsRaw: Record<string, unknown>;
}

export interface ProductUnifyOutcome {
  results: ProductUnifyResult[];
  problems: string[];
}

export const PRODUCT_UNIFY_PROMPT_RULES = `PRODUCT UNIFY rules:
- product_name is a clean, complete sellable-SKU name. Preserve meaningful product-line words and explicit strength/flavor/size/form, but remove storefront noise, repeated brand text, review text, price, shipping copy, and duplicated phrases. Never invent a claim or attribute.
- base_name is the cross-channel product-line name: remove a leading brand plus flavor, size/net content, serving count, pack count, dosage strength, and dosage form. Preserve product-line distinctions such as Ultra Strength, 50+, Gold, Plus, Kids, and named editions when they identify the line. Return null when the line cannot be isolated reliably.
- variant is strict and may contain ONLY: flavor, size, servings, pack, strength, edition, form.
- Copy every supplied STRUCTURED_VARIANT value exactly. Use title/ATTRS_RAW only to add an explicitly stated missing dimension; never guess Unflavored, pack=1, or an omitted dimension.
- size is net content/count, servings is servings per container, pack is multipack quantity, and strength is per-serving dosage. Do not swap these meanings.
- form must be one canonical value: ${CANONICAL_VARIANT_FORMS.join(" | ")}.
- Each dimension must be one clean value. Never return comma-joined alternatives or dirty labels such as Item weight400.0 grams.
- variant_confidence is an honest integer 0-100. Use less than 70 when any returned dimension is uncertain.
- Align results by a stable record identifier, never by array position.`;

function inputBlock(input: ProductUnifyInput) {
  return [
    `### ${input.clientRef}`,
    `CHANNEL: ${input.channel}`,
    `BRAND: ${input.brand ?? ""}`,
    `TITLE_RAW: ${input.titleRaw.slice(0, 500)}`,
    `STRUCTURED_VARIANT: ${JSON.stringify(input.structuredVariant)}`,
    `ATTRS_RAW: ${JSON.stringify(input.attrsRaw).slice(0, 2000)}`,
    `PRODUCT_FORM_HINT: ${input.productFormHint ?? ""}`,
  ].join("\n");
}

export function buildProductUnifyPrompt(inputs: ProductUnifyInput[]) {
  return `You normalize product identity across Amazon, GNC, Swanson, and first-party DTC stores.

${PRODUCT_UNIFY_PROMPT_RULES}

Return ONLY a JSON array with one object per block:
[{"client_ref":string,"product_name":string,"base_name":string|null,"variant":object,"variant_confidence":integer}]
Return one result for every client_ref and preserve each client_ref exactly.
No prose and no markdown fence.

${inputs.map(inputBlock).join("\n\n")}`;
}

const FORM_ALIASES: Record<string, ProductVariant["form"]> = {
  capsule: "capsule",
  capsules: "capsule",
  caplet: "tablet",
  caplets: "tablet",
  tablet: "tablet",
  tablets: "tablet",
  softgel: "softgel",
  softgels: "softgel",
  "soft gel": "softgel",
  "soft gels": "softgel",
  gelcap: "softgel",
  gelcaps: "softgel",
  gummy: "gummy",
  gummies: "gummy",
  chewable: "chewable",
  chewables: "chewable",
  powder: "powder",
  powders: "powder",
  pwdr: "powder",
  pwdrs: "powder",
  cap: "capsule",
  caps: "capsule",
  tab: "tablet",
  tabs: "tablet",
  liquid: "liquid",
  oil: "oil",
  spray: "spray",
  lozenge: "lozenge",
  lozenges: "lozenge",
  "stick pack": "stick_pack",
  "stick packs": "stick_pack",
  stick_pack: "stick_pack",
  sachet: "sachet",
  sachets: "sachet",
  "soft chew": "soft_chew",
  "soft chews": "soft_chew",
  soft_chew: "soft_chew",
  tea: "tea",
  bar: "bar",
  bars: "bar",
  pellet: "pellet",
  pellets: "pellet",
  gel: "gel",
  cream: "cream",
};

export function canonicalVariantForm(raw: unknown): ProductVariant["form"] | undefined {
  const key = String(raw ?? "").trim().toLowerCase().replace(/[-_]+/g, " ");
  return FORM_ALIASES[key] ?? FORM_ALIASES[key.replace(/\s+/g, " ")];
}

function normalizeWhitespace(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value;
}

function isDirtyVariantText(value: string) {
  if (/item\s*weight\s*\d/i.test(value)) return true;
  const forms = value.split(",").map((part) => canonicalVariantForm(part)).filter(Boolean);
  return forms.length > 1;
}

function parseScalar(value: unknown) {
  const normalized = normalizeWhitespace(value);
  if (typeof normalized === "number") return Number.isFinite(normalized) && normalized > 0 ? normalized : undefined;
  if (typeof normalized !== "string" || !normalized || isDirtyVariantText(normalized)) return undefined;
  return normalized;
}

/**
 * Product Server 的 strength 解析器只接受一个数值加一个标准单位。渠道标题常把
 * CFU 写成带星号或 `/Serving` 的展示形式；星号和 serving 是脚注，不是变体值。
 * 这里只剥这种可证明等价的展示噪音，不换算或猜测剂量。
 */
export function canonicalVariantStrength(value: unknown) {
  const normalized = normalizeWhitespace(value);
  if (typeof normalized !== "string") return normalized;
  const match = normalized.match(
    /^(\d+(?:,\d{3})*(?:\.\d+)?)\s*(billion|million)\s+cfus?\s*\**(?:\s*\/\s*(?:per\s*)?serving)?$/i,
  );
  if (!match) return normalized;
  return `${match[1]} ${match[2]![0]!.toUpperCase()}${match[2]!.slice(1).toLowerCase()} CFU`;
}

function parseVariant(raw: unknown, clientRef: string, problems: string[]) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const extras = Object.keys(value).filter((key) => !(PRODUCT_VARIANT_KEYS as readonly string[]).includes(key));
  let dirty = extras.length > 0;
  if (extras.length > 0) problems.push(`${clientRef}: variant 含非法字段 ${extras.join(", ")}，已丢弃并降低置信度`);
  const candidate: Record<string, unknown> = {};
  for (const key of PRODUCT_VARIANT_KEYS) {
    const rawValue = value[key];
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;
    if (key === "form") {
      const form = canonicalVariantForm(rawValue);
      if (form) candidate.form = form;
      else {
        dirty = true;
        problems.push(`${clientRef}: form「${String(rawValue)}」不在封闭词表，已丢弃`);
      }
      continue;
    }
    if ((key === "size" || key === "strength") && rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      const size = rawValue as Record<string, unknown>;
      const valueNumber = typeof size.value === "number" ? size.value : Number(size.value);
      const unit = parseScalar(size.unit);
      if (Number.isFinite(valueNumber) && valueNumber > 0 && typeof unit === "string") candidate[key] = { value: valueNumber, unit };
      else {
        dirty = true;
        problems.push(`${clientRef}: size 对象非法，已丢弃`);
      }
      continue;
    }
    const scalar = parseScalar(key === "strength" ? canonicalVariantStrength(rawValue) : rawValue);
    if (scalar === undefined) {
      dirty = true;
      problems.push(`${clientRef}: ${key} 不是干净单值，已丢弃`);
      continue;
    }
    candidate[key] = scalar;
  }
  const parsed = productVariantSchema.safeParse(candidate);
  return { variant: parsed.success ? parsed.data : {}, dirty: dirty || !parsed.success };
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const FORM_DISPLAY: Record<NonNullable<ProductVariant["form"]>, string> = {
  capsule: "Capsules",
  tablet: "Tablets",
  softgel: "Softgels",
  gummy: "Gummies",
  chewable: "Chewables",
  powder: "Powder",
  liquid: "Liquid",
  oil: "Oil",
  spray: "Spray",
  lozenge: "Lozenges",
  stick_pack: "Stick Packs",
  sachet: "Sachets",
  soft_chew: "Soft Chews",
  tea: "Tea",
  bar: "Bars",
  pellet: "Pellets",
  gel: "Gel",
  cream: "Cream",
};

const FORM_NAME_PATTERNS: Record<NonNullable<ProductVariant["form"]>, RegExp> = {
  capsule: /\b(?:capsules?|caps?)\b/i,
  tablet: /\b(?:tablets?|tabs?|caplets?)\b/i,
  softgel: /\b(?:soft\s*gels?|softgels?|gelcaps?)\b/i,
  gummy: /\b(?:gummy|gummies)\b/i,
  chewable: /\bchewables?\b/i,
  powder: /\bpowders?\b/i,
  liquid: /\bliquids?\b/i,
  oil: /\boils?\b/i,
  spray: /\bsprays?\b/i,
  lozenge: /\blozenges?\b/i,
  stick_pack: /\bstick\s*packs?\b/i,
  sachet: /\bsachets?\b/i,
  soft_chew: /\bsoft\s*chews?\b/i,
  tea: /\bteas?\b/i,
  bar: /\bbars?\b/i,
  pellet: /\bpellets?\b/i,
  gel: /\bgels?\b/i,
  cream: /\bcreams?\b/i,
};

function comparable(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const COUNT_FORM = "(?:count|ct|capsules?|caps?|tablets?|tabs?|caplets?|soft\\s*gels?|softgels?|gelcaps?|gummies|gummy|chewables?|lozenges?|sachets?|stick\\s*packs?|soft\\s*chews?|bars?|pellets?)";

function countDimension(value: unknown) {
  return typeof value === "string" ? value.match(new RegExp(`^\\s*(\\d+)\\s*${COUNT_FORM}\\s*$`, "i"))?.[1] : undefined;
}

function hasEquivalentCount(productName: string, count: string) {
  return new RegExp(`\\b${count}(?:\\s+[a-z][a-z-]*){0,3}\\s+${COUNT_FORM}\\b`, "i").test(productName);
}

function variantDisplay(key: keyof ProductVariant, value: NonNullable<ProductVariant[keyof ProductVariant]>) {
  if (key === "form") return FORM_DISPLAY[value as NonNullable<ProductVariant["form"]>];
  if (typeof value === "object") return `${value.value} ${value.unit}`;
  if (key === "pack" && typeof value === "number") return `Pack of ${value}`;
  if (key === "servings" && /^(?:\d+|\d+\s*servings?)$/i.test(String(value).trim())) {
    return `${String(value).match(/\d+/)?.[0]} Servings`;
  }
  return String(value);
}

function productNameHasVariant(productName: string, key: keyof ProductVariant, value: NonNullable<ProductVariant[keyof ProductVariant]>) {
  if (key === "form") return FORM_NAME_PATTERNS[value as NonNullable<ProductVariant["form"]>].test(productName);
  const display = variantDisplay(key, value);
  const nameComparable = comparable(productName);
  if (nameComparable.includes(comparable(display))) return true;
  if (key === "size" && typeof value === "string") {
    const count = countDimension(value);
    if (count && hasEquivalentCount(productName, count)) return true;
  }
  if (key === "strength" && typeof value === "string") {
    const amount = value.match(/^\s*(\d[\d,.]*\s*(?:mcg|mg|g|kg|iu|cfu|ml|oz|lb))\b/i)?.[1];
    return Boolean(amount && nameComparable.includes(comparable(amount)));
  }
  if (key === "pack") {
    const count = typeof value === "number" ? value : String(value).match(/\d+/)?.[0];
    return Boolean(count && new RegExp(`\\b(?:pack\\s+of\\s+${count}|${count}\\s*[- ]?pack)\\b`, "i").test(productName));
  }
  return false;
}

export function completeProductNameWithVariant(productName: string, variant: ProductVariant) {
  const parts = productName.split(",").map((part) => part.trim()).filter(Boolean);
  const sizeCount = countDimension(variant.size);
  const sizeDisplay = variant.size == null ? null : comparable(variantDisplay("size", variant.size));
  const withoutSizeSuffix = parts.filter((part, index) => !(index > 0
    && sizeCount
    && comparable(part) === sizeDisplay
    && hasEquivalentCount(parts.filter((_, other) => other !== index).join(", "), sizeCount)));
  const servingsCount = variant.servings == null ? null : String(variant.servings).match(/\d+/)?.[0];
  const cleanedParts = withoutSizeSuffix.filter((part, index, all) => !(index > 0
    && servingsCount
    && comparable(part) === servingsCount
    && all.some((other, otherIndex) => otherIndex !== index && comparable(other) === `${servingsCount} servings`)));
  const cleanedName = cleanedParts.join(", ");
  const missing = PRODUCT_VARIANT_KEYS.flatMap((key) => {
    const value = variant[key];
    return value == null || productNameHasVariant(cleanedName, key, value) ? [] : [variantDisplay(key, value)];
  });
  return missing.length ? `${cleanedName}, ${missing.join(", ")}` : cleanedName;
}

export function parseProductUnifyOutput(raw: string, expected: ProductUnifyInput[]): ProductUnifyOutcome {
  const problems: string[] = [];
  const array = extractLastJsonArray(raw);
  if (!array) return { results: [], problems: ["Product Unify 输出里没有可解析的 JSON 数组"] };
  const expectedByRef = new Map(expected.map((item) => [item.clientRef, item]));
  const byRef = new Map<string, ProductUnifyResult>();

  for (const item of array) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const clientRef = String(row.client_ref ?? "").trim();
    const input = expectedByRef.get(clientRef);
    if (!input) {
      if (clientRef) problems.push(`Product Unify 返回了未请求的 client_ref：${clientRef}`);
      continue;
    }
    const rawProductName = String(row.product_name ?? "").trim().replace(/\s+/g, " ");
    if (!rawProductName) {
      problems.push(`${clientRef}: product_name 为空，已丢弃结果`);
      continue;
    }
    const rawBaseName = row.base_name == null ? null : String(row.base_name).trim().replace(/\s+/g, " ");
    const baseName = rawBaseName || null;
    const parsed = parseVariant(row.variant, clientRef, problems);
    const structured = parseVariant(input.structuredVariant, `${clientRef}:structured`, problems);
    const variant = { ...parsed.variant, ...structured.variant };
    const productName = completeProductNameWithVariant(rawProductName, variant);
    const hasAiDimension = Object.entries(variant).some(([key, value]) => !sameValue(structured.variant[key as keyof ProductVariant], value));
    const suppliedConfidence = Number(row.variant_confidence);
    let variantConfidence = Number.isFinite(suppliedConfidence) ? Math.max(0, Math.min(100, Math.round(suppliedConfidence))) : 0;
    if (!Number.isFinite(suppliedConfidence)) problems.push(`${clientRef}: variant_confidence 缺失，按 0 处理`);
    if (parsed.dirty || structured.dirty) variantConfidence = Math.min(variantConfidence, 69);
    byRef.set(clientRef, {
      clientRef,
      productName,
      baseName,
      variant: productVariantSchema.parse(variant),
      variantConfidence,
      variantSource: hasAiDimension || Object.keys(structured.variant).length === 0 ? "ai_extract" : "channel_attrs",
      attrsRaw: input.attrsRaw,
    });
  }

  for (const input of expected) if (!byRef.has(input.clientRef)) problems.push(`${input.clientRef}: Product Unify 没有返回合法结果`);
  return {
    results: expected.map((input) => byRef.get(input.clientRef)).filter((item): item is ProductUnifyResult => Boolean(item)),
    problems,
  };
}

/**
 * 按变体家族分批：同一 family 的成员永远落在同一批，绝不跨调用拆开。
 *
 * 规则：
 * - 有 familyKey 的先按 family 聚拢；family 本身超过 batchSize 时**整体成为一批**
 *   （宁可批次偏大，也不能把兄弟拆开——拆开就等于放弃了这次改动的全部意义）。
 * - 没有 familyKey 的条目按原来的顺序填进剩余空位。
 * - 家族内部保持输入顺序，输出仍与输入一一对应。
 */
export function groupInputsIntoBatches(inputs: readonly ProductUnifyInput[], batchSize: number) {
  const families = new Map<string, ProductUnifyInput[]>();
  const singles: ProductUnifyInput[] = [];
  for (const input of inputs) {
    const key = input.familyKey?.trim();
    if (!key) { singles.push(input); continue; }
    const bucket = families.get(key);
    if (bucket) bucket.push(input); else families.set(key, [input]);
  }
  const batches: ProductUnifyInput[][] = [];
  let current: ProductUnifyInput[] = [];
  const flush = () => { if (current.length) { batches.push(current); current = []; } };
  // 大家族独占一批；小家族依次装箱，装不下就先封箱再开新批。
  for (const members of families.values()) {
    if (members.length >= batchSize) { flush(); batches.push(members); continue; }
    if (current.length + members.length > batchSize) flush();
    current.push(...members);
  }
  for (const single of singles) {
    if (current.length >= batchSize) flush();
    current.push(single);
  }
  flush();
  return batches;
}

export async function runProductUnify(options: {
  inputs: ProductUnifyInput[];
  runModel: (input: { prompt: string; tag: string }) => Promise<string>;
  tagPrefix: string;
  batchSize?: number;
  concurrency?: number;
}): Promise<ProductUnifyOutcome> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 20));
  const batches = groupInputsIntoBatches(options.inputs, batchSize);
  const outcomes: ProductUnifyOutcome[] = new Array(batches.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, options.concurrency ?? 2), batches.length) }, async () => {
    while (cursor < batches.length) {
      const index = cursor++;
      const batch = batches[index]!;
      const prompt = `${buildProductUnifyPrompt(batch)}\nIMPORTANT: Return one object with one string field named payload, and serialize the requested JSON array exactly inside payload.`;
      const raw = await options.runModel({ prompt, tag: `${options.tagPrefix}-${index}` });
      outcomes[index] = parseProductUnifyOutput(raw, batch);
    }
  }));
  return {
    results: outcomes.flatMap((outcome) => outcome.results),
    problems: outcomes.flatMap((outcome) => outcome.problems),
  };
}
