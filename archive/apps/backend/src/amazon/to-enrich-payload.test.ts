import { describe, expect, it } from "vitest";
import type { ExtractedProduct } from "./extract-product";
import type { CleanResult } from "./semantic-clean";
import { MissingDomainError, toEnrichPayload } from "./to-enrich-payload";

const extracted = (over: Partial<ExtractedProduct> = {}): ExtractedProduct => ({
	title: "NOW Foods Zinc 50mg",
	brand: "NOW Foods",
	price: null,
	currency: null,
	rating: null,
	reviewCount: null,
	salesRank: null,
	inStock: null,
	images: [],
	itemForm: null,
	unitCount: null,
	dateFirstAvailable: null,
	manufacturer: null,
	unitsSold: null,
	unitsSoldPeriod: null,
	ingredientsText: null,
	ingredients: [],
	bullets: null,
	description: null,
	aplusText: null,
	...over,
});
const semantic = (over: Partial<CleanResult> = {}): CleanResult => ({
	asin: "B001",
	healthFunctions: ["Immune Support"],
	productForm: "capsule",
	ingredients: ["Zinc"],
	scopeDecision: "included",
	scopeReason: "nutrition_product",
	scopeEvidence: ["Ingredients: Zinc"],
	...over,
});

const base = {
	asin: "B001",
	companyDomain: "nowfoods.com",
	capturedAt: new Date("2026-08-12T10:00:00Z"),
};

describe("toEnrichPayload", () => {
	it("固定字段按契约填好", () => {
		const p = toEnrichPayload({
			...base,
			extracted: extracted(),
			semantic: semantic(),
		});
		expect(p.channel).toBe("amazon");
		expect(p.externalId).toBe("B001");
		expect(p.sourceUrl).toBe("https://www.amazon.com/dp/B001");
		expect(p.domain).toBe("nowfoods.com");
		expect(p.capturedAt).toBe("2026-08-12T10:00:00.000Z");
	});

	it("crawlScope 缺省为 partial，并接受 run 级完整 Brand Store 门禁的 full", () => {
		const p = toEnrichPayload({
			...base,
			extracted: extracted(),
			semantic: semantic(),
		});
		expect(p.crawlScope).toBe("partial");
		expect(toEnrichPayload({
			...base,
			extracted: extracted(),
			semantic: semantic(),
			crawlScope: "full",
		}).crawlScope).toBe("full");
	});

	it("语义清洗的结果优先", () => {
		const p = toEnrichPayload({
			...base,
			extracted: extracted({ ingredients: ["规则切的"] }),
			semantic: semantic({ ingredients: ["模型切的"] }),
		});
		expect(p.mainIngredients).toEqual(["模型切的"]);
		expect(p.healthFunctions).toEqual(["Immune Support"]);
		expect(p.productForm).toBe("capsule");
	});

	it("没跑语义清洗时拒绝入库，不退回规则候选", () => {
		expect(() =>
			toEnrichPayload({
				...base,
				extracted: extracted({ ingredients: ["zinc", "gelatin"] }),
				semantic: null,
			}),
		).toThrow(/缺少 Nutrition 语义终判/);
	});

	it("拒绝没有 ingredients/formula 的 included 结果", () => {
		expect(() =>
			toEnrichPayload({
				...base,
				extracted: extracted(),
				semantic: semantic({ ingredients: [] }),
			}),
		).toThrow(/ingredients_and_formula_missing/);
	});

	it("载荷携带最终 Nutrition 范围证据", () => {
		const p = toEnrichPayload({
			...base,
			extracted: extracted(),
			semantic: semantic(),
		});
		expect(p.nutritionScope).toEqual({
			policy: "nutrition_single_products",
			decision: "included",
			evidence: ["Ingredients: Zinc"],
		});
	});

	it("抠不到的可选字段直接不带 —— 带 null 会把库里已有的值覆盖成空", () => {
		const p = toEnrichPayload({
			...base,
			extracted: extracted(),
			semantic: semantic(),
		});
		expect(p).not.toHaveProperty("price");
		expect(p).not.toHaveProperty("rating");
		expect(p).not.toHaveProperty("inStock");
	});

	it("抠到了就带上", () => {
		const p = toEnrichPayload({
			...base,
			extracted: extracted({
				price: "10.76",
				currency: "USD",
				rating: 4.6,
				reviewCount: 5588,
				salesRank: 1234,
				inStock: true,
			}),
			semantic: semantic(),
		});
		expect(p.price).toBe("10.76");
		expect(p.rating).toBe(4.6);
		expect(p.inStock).toBe(true);
	});

	it("inStock=false 要带上 —— 不能被 falsy 判断吃掉", () => {
		const p = toEnrichPayload({
			...base,
			extracted: extracted({ inStock: false }),
			semantic: semantic(),
		});
		expect(p.inStock).toBe(false);
	});

	it("规格原文原样带上，归一在入库侧做", () => {
		const p = toEnrichPayload({
			...base,
			extracted: extracted({ itemForm: "Gelcap", unitCount: "90 Count" }),
			semantic: semantic(),
		});
		expect(p.variantAttrs).toEqual({ label: "Gelcap", pack: "90 Count" });
	});

	it("没有规格信息时不带 variantAttrs", () => {
		const p = toEnrichPayload({
			...base,
			extracted: extracted(),
			semantic: semantic(),
		});
		expect(p).not.toHaveProperty("variantAttrs");
	});

	it("缺域名时明确报错，不硬造一个入库", () => {
		expect(() =>
			toEnrichPayload({
				...base,
				companyDomain: "  ",
				extracted: extracted(),
				semantic: null,
			}),
		).toThrow(MissingDomainError);
	});

	it("缺标题时报错 —— 标题实测 100% 有，真为空说明存档本身有问题", () => {
		expect(() =>
			toEnrichPayload({
				...base,
				extracted: extracted({ title: null }),
				semantic: null,
			}),
		).toThrow(/没有商品标题/);
	});
});
