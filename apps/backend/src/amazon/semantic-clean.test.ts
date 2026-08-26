import { describe, expect, it } from "vitest";
import {
	buildBatchPrompt,
	type CleanInput,
	type CleanResult,
	chunk,
	enforceNutritionScope,
	extractLastJsonArray,
	parseBatchOutput,
} from "./semantic-clean";

const VOCAB = ["Immune Support", "Gut Health Support", "Energy Support"];

const input = (asin: string, over: Partial<CleanInput> = {}): CleanInput => ({
	asin,
	title: `Product ${asin}`,
	formField: null,
	bullets: null,
	description: null,
	aplusText: null,
	ingredientsRaw: null,
	...over,
});
const modelRow = (asin: string, over: Record<string, unknown> = {}) => ({
	asin,
	scope_decision: "included",
	scope_reason: "nutrition_product",
	scope_evidence: ["Ingredients: Zinc"],
	health_functions: ["Immune Support"],
	product_form: "capsule",
	ingredients: ["Zinc"],
	...over,
});

describe("chunk", () => {
	it("按大小切批，最后一批可以不满", () => {
		expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});

	it("空数组返回空", () => {
		expect(chunk([], 10)).toEqual([]);
	});

	it("批大小非法时退回 1，不至于死循环", () => {
		expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
	});
});

describe("buildBatchPrompt", () => {
	it("词表整份带上 —— 每批只付一次，换来输出可直接入库", () => {
		const p = buildBatchPrompt([input("B001")], VOCAB);
		for (const v of VOCAB) expect(p).toContain(v);
	});

	it("每条一个 ### 块", () => {
		const p = buildBatchPrompt([input("B001"), input("B002")], VOCAB);
		expect(p).toContain("### B001");
		expect(p).toContain("### B002");
	});

	it("超长字段截断 —— 多出来的部分对判断功效没有增量信息，纯烧 token", () => {
		const p = buildBatchPrompt(
			[input("B001", { bullets: "x".repeat(5000) })],
			VOCAB,
		);
		expect(p).not.toContain("x".repeat(1300));
	});

	it("null 字段不写成字面量 null", () => {
		expect(buildBatchPrompt([input("B001")], VOCAB)).not.toContain("null");
	});

	it("明确要求 Nutrition 单品终判和成分闸门", () => {
		const p = buildBatchPrompt([input("B001")], VOCAB);
		expect(p).toContain("scope_decision");
		expect(p).toContain("bundles/packs/kits/sets");
		expect(p).toContain("cannot be included with an empty ingredients array");
	});
});

describe("extractLastJsonArray", () => {
	it("取最后一个 —— Codex 会回显提示词，里面就有 schema 示例", () => {
		// 这是真实踩过的坑：取第一个匹配到的是提示词里那行 schema，必然解析失败
		const raw = `
			Output format: [{"asin": string, "health_functions": string[]}]
			...
			[{"asin":"B001","health_functions":["Immune Support"],"product_form":"capsule","ingredients":[]}]
		`;
		const arr = extractLastJsonArray(raw);
		expect(arr).toHaveLength(1);
		expect((arr?.[0] as { asin: string }).asin).toBe("B001");
	});

	it("没有可解析数组时返回 null", () => {
		expect(extractLastJsonArray("just prose, no json")).toBeNull();
	});

	it("末尾是坏 JSON 时回退到前面能解析的那个", () => {
		const raw = `[{"asin":"B001"}]  然后是被截断的 [{"asin":"B00`;
		expect(extractLastJsonArray(raw)).toHaveLength(1);
	});
});

describe("parseBatchOutput", () => {
	const expected = [input("B001"), input("B002")];

	it("正常解析两条", () => {
		const raw = JSON.stringify([
			modelRow("B001"),
			modelRow("B002", {
				health_functions: ["Energy Support"],
				product_form: "gummy",
				ingredients: ["Magnesium"],
			}),
		]);
		const { results, problems } = parseBatchOutput(raw, expected, VOCAB);
		expect(results).toHaveLength(2);
		expect(problems).toEqual([]);
		expect(results[0]?.ingredients).toEqual(["Zinc"]);
	});

	it("按 asin 对齐而不是按位置 —— 模型改顺序不会把 A 的功效安到 B 头上", () => {
		// 位置对齐时这种输出会静默污染数据，不报错
		const raw = JSON.stringify([
			modelRow("B002", { health_functions: ["Energy Support"] }),
			modelRow("B001"),
		]);
		const { results } = parseBatchOutput(raw, expected, VOCAB);
		expect(results[0]?.asin).toBe("B001");
		expect(results[0]?.healthFunctions).toEqual(["Immune Support"]);
	});

	it("丢弃词表外的功效并记一条问题", () => {
		const raw = `[{"asin":"B001","health_functions":["Immune Support","Made Up Thing"],"product_form":"capsule","ingredients":[]}]`;
		const { results, problems } = parseBatchOutput(
			raw,
			[expected[0] as CleanInput],
			VOCAB,
		);
		expect(results[0]?.healthFunctions).toEqual(["Immune Support"]);
		expect(problems.some((p) => p.includes("Made Up Thing"))).toBe(true);
	});

	it("不认识的剂型归到 other，不原样入库", () => {
		const raw = `[{"asin":"B001","health_functions":[],"product_form":"沖劑","ingredients":[]}]`;
		const { results } = parseBatchOutput(
			raw,
			[expected[0] as CleanInput],
			VOCAB,
		);
		expect(results[0]?.productForm).toBe("other");
	});

	it("漏返回的条目记一条问题，不静默丢失", () => {
		const raw = `[{"asin":"B001","health_functions":[],"product_form":"capsule","ingredients":[]}]`;
		const { results, problems } = parseBatchOutput(raw, expected, VOCAB);
		expect(results).toHaveLength(1);
		expect(
			problems.some((p) => p.includes("B002") && p.includes("没有返回")),
		).toBe(true);
	});

	it("返回了没送过的 asin 时丢弃并记录", () => {
		const raw = `[{"asin":"B999","health_functions":[],"product_form":"capsule","ingredients":[]}]`;
		const { results, problems } = parseBatchOutput(raw, expected, VOCAB);
		expect(results).toHaveLength(0);
		expect(problems.some((p) => p.includes("B999"))).toBe(true);
	});

	it("成分与功效各自去重", () => {
		const raw = JSON.stringify([
			modelRow("B001", {
				health_functions: ["Immune Support", "Immune Support"],
				ingredients: ["Zinc", "Zinc"],
			}),
		]);
		const { results } = parseBatchOutput(
			raw,
			[expected[0] as CleanInput],
			VOCAB,
		);
		expect(results[0]?.healthFunctions).toEqual(["Immune Support"]);
		expect(results[0]?.ingredients).toEqual(["Zinc"]);
	});

	it("整体解析失败时返回空结果 + 一条问题，不抛异常", () => {
		const { results, problems } = parseBatchOutput(
			"模型今天不想干活",
			expected,
			VOCAB,
		);
		expect(results).toEqual([]);
		expect(problems).toHaveLength(1);
	});
});

describe("Nutrition 最终范围闸门", () => {
	const result = (over: Partial<CleanResult> = {}): CleanResult => ({
		asin: "B001",
		healthFunctions: [],
		productForm: "capsule",
		ingredients: ["Vitamin C"],
		scopeDecision: "included",
		scopeReason: "nutrition_product",
		scopeEvidence: ["Vitamin C supplement"],
		...over,
	});

	it("确定性排除 bundle，即使模型误判 included", () => {
		expect(
			enforceNutritionScope(
				input("B001", { title: "Vitamin C Gummies Bundle Pack of 3" }),
				result(),
			),
		).toMatchObject({
			scopeDecision: "excluded",
			scopeReason: "bundle_or_pack",
		});
	});

	it("单独出现 pack 也按组合装排除", () => {
		expect(
			enforceNutritionScope(
				input("B001", { title: "Vitamin C Gummies Variety Pack" }),
				result(),
			),
		).toMatchObject({
			scopeDecision: "excluded",
			scopeReason: "bundle_or_pack",
		});
	});

	it.each([
		"Distilled White Vinegar Cleaning Wipes",
		"Reebok Classic Shoes",
		"Retinol Face Cream",
		"Hip & Joint Supplement for Dogs",
	])("确定性排除非 Nutrition：%s", (title) => {
		expect(
			enforceNutritionScope(input("B001", { title }), result()),
		).toMatchObject({
			scopeDecision: "excluded",
			scopeReason: "non_nutrition_product",
		});
	});

	it("没有成分时排除，不能先建空产品", () => {
		expect(
			enforceNutritionScope(input("B001"), result({ ingredients: [] })),
		).toMatchObject({
			scopeDecision: "excluded",
			scopeReason: "ingredients_and_formula_missing",
		});
	});
});
