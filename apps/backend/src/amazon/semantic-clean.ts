/**
 * 语义化清洗：把格式化清洗的产物交给模型，补上规则抠不出来的三件事 ——
 * 功效（`healthFunctions`）、剂型（`productForm`）、成分切分。
 *
 * **分工原则：模型负责切分，字典负责识别。**
 * 模型不需要认识成分 —— 产品库里 73,428 条成分名的字典比它可靠得多。它只需要
 * 判断「这段文字里哪几段是成分名、哪几段是免责声明」。功效同理：给定 295 条
 * 词表，从里面挑，不许自创。实测 20/50/60 条三轮，**0 个词表外的值**。
 *
 * 这一层是纯函数：切批、拼提示词、解析校验。真正调模型和落库在 clean-manager。
 */

/** 契约允许的剂型枚举 */
export const PRODUCT_FORMS = [
	"capsule",
	"tablet",
	"softgel",
	"gummy",
	"powder",
	"liquid",
	"spray",
	"cream",
	"other",
] as const;

export type ProductForm = (typeof PRODUCT_FORMS)[number];

export const NUTRITION_SCOPE_REASONS = [
	"nutrition_product",
	"non_nutrition_product",
	"bundle_or_pack",
	"ingredients_and_formula_missing",
	"nutrition_evidence_missing",
] as const;

export type NutritionScopeReason = (typeof NUTRITION_SCOPE_REASONS)[number];

/** 送进模型的单条输入 —— 只带模型真正需要的字段，其余一律不送（省 token） */
export interface CleanInput {
	asin: string;
	title: string | null;
	/** 页面上的 Item Form 字段，有就当强提示 */
	formField: string | null;
	bullets: string | null;
	description: string | null;
	aplusText: string | null;
	/** 成分段原文，交给模型切分 */
	ingredientsRaw: string | null;
}

export interface CleanResult {
	asin: string;
	healthFunctions: string[];
	productForm: ProductForm;
	ingredients: string[];
	scopeDecision: "included" | "excluded";
	scopeReason: NutritionScopeReason;
	scopeEvidence: string[];
}

export interface ParseOutcome {
	results: CleanResult[];
	/** 每条问题一句话，便于在运行记录里回溯 */
	problems: string[];
}

/**
 * 批大小。
 *
 * 实测（gpt-5.5 / Codex CLI）：20 条 59 秒、50 条 142 秒，拟合出
 * **固定开销 3.6 秒/次 + 变动 2.77 秒/条**。固定开销很小，所以再加大批次
 * 收益有限，反而让单次失败的重跑代价变大。50 是个平衡点。
 */
export const DEFAULT_BATCH_SIZE = 50;

/** 每条输入各字段的截断长度 —— 超过这个长度对判断功效没有增量信息，纯烧 token */
const LIMITS = {
	title: 200,
	bullets: 1200,
	description: 700,
	aplus: 900,
	ingredients: 900,
} as const;

export function chunk<T>(items: T[], size: number): T[][] {
	const n = Math.max(1, Math.floor(size));
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
	return out;
}

function block(input: CleanInput): string {
	const cut = (s: string | null, n: number) => (s ?? "").slice(0, n);
	return [
		`### ${input.asin}`,
		`TITLE: ${cut(input.title, LIMITS.title)}`,
		`FORM_FIELD: ${input.formField ?? ""}`,
		`BULLETS: ${cut(input.bullets, LIMITS.bullets)}`,
		`DESC: ${cut(input.description, LIMITS.description)}`,
		`APLUS: ${cut(input.aplusText, LIMITS.aplus)}`,
		`INGREDIENTS_RAW: ${cut(input.ingredientsRaw, LIMITS.ingredients)}`,
	].join("\n");
}

/**
 * 拼一批的提示词。
 *
 * 功效词表整份塞进去（295 条约 1,355 token）——**每批只付一次**，摊到 50 条
 * 上是每条 27 token，换来输出可直接入库、不需要事后模糊匹配，非常划算。
 */
export function buildBatchPrompt(
	inputs: CleanInput[],
	healthFunctionVocabulary: string[],
): string {
	return `You are normalizing Amazon product data for a HUMAN NUTRITION database. For EACH "### ASIN" block below, output one JSON object.

Rules:
- scope_decision: "included" only for one sellable human oral nutrition product. Exclude bundles/packs/kits/sets, topical/beauty/cosmetics, household/cleaning, apparel/accessories/devices, pet/veterinary products, and anything without positive nutrition evidence.
- scope_reason: nutrition_product when included; otherwise exactly one of non_nutrition_product, bundle_or_pack, ingredients_and_formula_missing, nutrition_evidence_missing.
- scope_evidence: 1-5 short excerpts from TITLE/FORM_FIELD/BULLETS/DESC/APLUS/INGREDIENTS_RAW that justify the decision. Never invent evidence.
- health_functions: pick ONLY from the allowed list below. Choose 1-4 that the marketing copy actually claims. Empty array if none apply. Never invent a value outside the list.
- product_form: one of ${PRODUCT_FORMS.join("/")}. Prefer FORM_FIELD when present, otherwise infer from the copy.
- ingredients: segment INGREDIENTS_RAW into individual ingredient names. Drop anything that is not an ingredient (allergen warnings, disclaimers, "labeling", "treat", "cure", legal text). Keep the original spelling. Empty array if INGREDIENTS_RAW is empty or contains no real ingredients.
- A record cannot be included with an empty ingredients array. This product batch has no separate formula field inside each product, so formula/Facts evidence must be materialized into ingredient names before inclusion.

Output ONLY a JSON array, one object per ASIN, in the same order:
[{"asin": string, "scope_decision": "included"|"excluded", "scope_reason": string, "scope_evidence": string[], "health_functions": string[], "product_form": string, "ingredients": string[]}]
No prose, no markdown fence.

ALLOWED health_functions:
${healthFunctionVocabulary.join(" | ")}

---
${inputs.map(block).join("\n\n")}
`;
}

/** 从一段可能混着别的东西的输出里，捞出最后一个能解析的 JSON 数组。 */
export function extractLastJsonArray(raw: string): unknown[] | null {
	// ⚠️ 必须取**最后**一个。Codex CLI 会把提示词原样回显，而提示词里就有一行
	// JSON schema 示例（`[{"asin": string, ...}]`）——取第一个必然解析失败。
	const candidates = raw.match(/\[\s*\{[\s\S]*?\}\s*\]/g);
	if (!candidates) return null;
	for (let i = candidates.length - 1; i >= 0; i--) {
		try {
			const parsed = JSON.parse(candidates[i] as string);
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// 试下一个
		}
	}
	return null;
}

function normalizeForm(raw: unknown): ProductForm {
	const s = String(raw ?? "")
		.toLowerCase()
		.trim();
	return (PRODUCT_FORMS as readonly string[]).includes(s)
		? (s as ProductForm)
		: "other";
}

const BUNDLE_RE =
	/\b(?:bundle|kit|stack|collection|regimen|starter\s+set|gift\s+set|pack|duo|trio)\b/i;
const NON_NUTRITION_RE =
	/\b(?:shoes?|sneakers?|hoodie|shorts?|hangers?|napkins?|storage\s+bags?|cables?|door\s+hinge|cake\s+pan|cord\s+cover|postal\s+scale|dinner\s+bowl|cleaning|wipes?|detergent|dish\s*wash|dryer\s+sheet|fabric\s+softener|cream|lotion|moisturizer|sunscreen|mascara|lip\s+(?:oil|gloss|color)|cleanser|body\s+(?:wash|butter)|shampoo|conditioner|deodorant|makeup|cosmetic|topical)\b/i;
const PET_RE =
	/\b(?:for\s+(?:dogs?|cats?|pets?)|(?:dog|cat|pet)\s+(?:supplement|chews?|treats?|food)|canine|feline|equine|veterinary)\b/i;

/**
 * 模型结论之后的确定性终判。模型漏字段或误把明显非 Nutrition 判 included 时，
 * 一律保守排除；当前 product batch 的产品载荷没有独立 formula 字段，所以 ingredients 必须非空。
 */
export function enforceNutritionScope(
	input: CleanInput,
	result: CleanResult,
): CleanResult {
	const text = [
		input.title,
		input.formField,
		input.bullets,
		input.description,
		input.aplusText,
	]
		.filter(Boolean)
		.join(" ");
	if (BUNDLE_RE.test(text)) {
		return {
			...result,
			scopeDecision: "excluded",
			scopeReason: "bundle_or_pack",
			scopeEvidence: [input.title ?? "bundle/pack evidence"],
		};
	}
	if (NON_NUTRITION_RE.test(text) || PET_RE.test(text)) {
		return {
			...result,
			scopeDecision: "excluded",
			scopeReason: "non_nutrition_product",
			scopeEvidence: [
				input.title ?? input.formField ?? "non-nutrition evidence",
			],
		};
	}
	if (result.scopeDecision !== "included") return result;
	if (result.ingredients.length === 0) {
		return {
			...result,
			scopeDecision: "excluded",
			scopeReason: "ingredients_and_formula_missing",
		};
	}
	if (result.scopeEvidence.length === 0) {
		return {
			...result,
			scopeDecision: "excluded",
			scopeReason: "nutrition_evidence_missing",
		};
	}
	return { ...result, scopeReason: "nutrition_product" };
}

/**
 * 解析并校验一批输出。
 *
 * **按 ASIN 对齐，不按位置。** 模型偶尔会漏一条或改顺序，按下标取会把 A 的
 * 功效安到 B 头上 —— 那种错不会报错，只会静默污染数据。
 *
 * 词表外的功效值直接丢弃并记一条 problem：宁可这条少几个功效，也不能让
 * 库里出现一个不存在的 health_function（它后面要按名字关联到既有表）。
 */
export function parseBatchOutput(
	raw: string,
	expected: CleanInput[],
	healthFunctionVocabulary: string[],
): ParseOutcome {
	const problems: string[] = [];
	const arr = extractLastJsonArray(raw);
	if (!arr) {
		return { results: [], problems: ["输出里没有可解析的 JSON 数组"] };
	}

	const vocab = new Set(healthFunctionVocabulary);
	const validReasons = new Set<string>(NUTRITION_SCOPE_REASONS);
	const wanted = new Set(expected.map((e) => e.asin));
	const inputByAsin = new Map(expected.map((e) => [e.asin, e]));
	const byAsin = new Map<string, CleanResult>();

	for (const item of arr) {
		if (typeof item !== "object" || item === null) continue;
		const row = item as Record<string, unknown>;
		const asin = String(row.asin ?? "").trim();
		if (!asin) {
			problems.push("有一条结果没有 asin，已丢弃");
			continue;
		}
		if (!wanted.has(asin)) {
			problems.push(`结果里出现了本批没送过的 asin：${asin}`);
			continue;
		}

		const rawHf = Array.isArray(row.health_functions)
			? row.health_functions
			: [];
		const healthFunctions: string[] = [];
		for (const v of rawHf) {
			const s = String(v).trim();
			if (vocab.has(s)) healthFunctions.push(s);
			else if (s) problems.push(`${asin}: 词表外的功效「${s}」已丢弃`);
		}

		const ingredients = (Array.isArray(row.ingredients) ? row.ingredients : [])
			.map((v) => String(v).trim())
			.filter(Boolean);
		const scopeDecision =
			row.scope_decision === "included" ? "included" : "excluded";
		if (
			row.scope_decision !== "included" &&
			row.scope_decision !== "excluded"
		) {
			problems.push(`${asin}: scope_decision 缺失或非法，按 excluded 处理`);
		}
		const rawReason = String(row.scope_reason ?? "").trim();
		const scopeReason = validReasons.has(rawReason)
			? (rawReason as NutritionScopeReason)
			: "nutrition_evidence_missing";
		if (!validReasons.has(rawReason)) {
			problems.push(
				`${asin}: scope_reason 缺失或非法，按 nutrition_evidence_missing 处理`,
			);
		}
		const scopeEvidence = (
			Array.isArray(row.scope_evidence) ? row.scope_evidence : []
		)
			.map((v) => String(v).trim())
			.filter(Boolean)
			.slice(0, 5);

		const parsed: CleanResult = {
			asin,
			healthFunctions: [...new Set(healthFunctions)],
			productForm: normalizeForm(row.product_form),
			ingredients: [...new Set(ingredients)],
			scopeDecision,
			scopeReason,
			scopeEvidence,
		};
		byAsin.set(
			asin,
			enforceNutritionScope(inputByAsin.get(asin) as CleanInput, parsed),
		);
	}

	for (const e of expected) {
		if (!byAsin.has(e.asin)) problems.push(`${e.asin}: 模型没有返回结果`);
	}

	// 按送入顺序返回，便于和输入对照
	const results = expected
		.map((e) => byAsin.get(e.asin))
		.filter((r): r is CleanResult => Boolean(r));

	return { results, problems };
}
