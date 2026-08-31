/**
 * 组装 product-db 的入库载荷。
 *
 * 契约权威方是 `packages/database-api` 的 `EnrichProductInputSchema`
 * （见 docs/product-db-v2/02-ingestion.md）。这里只负责把
 * 「格式化清洗产物 + 语义清洗产物 + 公司反查结果」拼成它要的形状，
 * 不做任何判断 —— 判断都在上游做完了。
 */

import type { ExtractedProduct } from "./extract-product.js";
import type { CleanResult } from "./semantic-clean.js";

/**
 * 与 `EnrichProductInputSchema` 对齐的子集（我们能提供的字段）。
 * 故意不 import 那边的类型：link-monitor 是独立部署的应用，跨包耦合类型会
 * 让它的构建被 database-api 的改动牵连。字段名对齐即可，契约由那边校验。
 */
export interface EnrichPayload {
	domain: string;
	productName: string;
	productUrl?: string;
	channel: string;
	externalId: string;
	sourceUrl: string;
	capturedAt: string;
	crawlScope: "full" | "partial";
	source: string;
	price?: string;
	currency?: string;
	rating?: number;
	reviewCount?: number;
	salesRank?: number;
	inStock?: boolean;
	/** 近期销量的近似下界（Amazon 只给 `50+` / `2K+` 这种档位） */
	unitsSold?: number;
	/** 销量窗口 `week` / `month` —— 两者不可比，必须跟着值一起走 */
	unitsSoldPeriod?: string;
	images: string[];
	healthFunctions: string[];
	mainIngredients: string[];
	productForm: string;
	nutritionScope: {
		policy: "nutrition_single_products";
		decision: "included";
		evidence: string[];
	};
	variantAttrs?: { label?: string; pack?: string };
}

export interface PayloadInput {
	asin: string;
	extracted: ExtractedProduct;
	semantic: CleanResult | null;
	/** 从 brand.company_id 反查 company.website 得到；契约里是必填 */
	companyDomain: string;
	/** 抓取时刻（存档时间），**不是**清洗时刻 */
	capturedAt: Date;
	/** run 级目录门禁的结果；单品/搜索为 partial，完整 Brand Store 才能为 full */
	crawlScope?: "full" | "partial";
	/** 观测来源标签，落进 snapshot.source */
	source?: string;
}

export class MissingDomainError extends Error {
	constructor(asin: string) {
		super(`${asin}: 缺少公司域名，无法入库（契约里 domain 是必填）`);
		this.name = "MissingDomainError";
	}
}

export function amazonProductUrl(asin: string): string {
	return `https://www.amazon.com/dp/${asin}`;
}

/**
 * 组装一条载荷。
 *
 * `crawlScope` 只能来自三渠道共用的 run 级目录门禁，不能由单个商品或模型决定。
 */
export function toEnrichPayload(input: PayloadInput): EnrichPayload {
	const { asin, extracted, semantic, companyDomain, capturedAt } = input;

	const domain = companyDomain.trim();
	if (!domain) throw new MissingDomainError(asin);

	const productName = extracted.title?.trim();
	if (!productName) {
		// 标题实测 100% 有；真为空说明那份存档本身有问题，不该硬造一个名字入库
		throw new Error(`${asin}: 没有商品标题，跳过`);
	}
	if (!semantic) {
		throw new Error(`${asin}: 缺少 Nutrition 语义终判，跳过`);
	}
	if (semantic.scopeDecision !== "included") {
		throw new Error(`${asin}: ${semantic.scopeReason}，跳过`);
	}
	if (semantic.ingredients.length === 0) {
		throw new Error(`${asin}: ingredients_and_formula_missing，跳过`);
	}

	const url = amazonProductUrl(asin);
	const payload: EnrichPayload = {
		domain,
		productName,
		productUrl: url,
		channel: "amazon",
		externalId: asin,
		sourceUrl: url,
		capturedAt: capturedAt.toISOString(),
		crawlScope: input.crawlScope ?? "partial",
		source: input.source ?? "link-monitor",
		images: extracted.images,
		healthFunctions: semantic.healthFunctions,
		mainIngredients: semantic.ingredients,
		productForm: semantic.productForm,
		nutritionScope: {
			policy: "nutrition_single_products",
			decision: "included",
			evidence: semantic.scopeEvidence,
		},
	};

	// 可选字段：**只在真有值时才带上**。带 null 进去会把库里已有的值覆盖成空，
	// 而「这次没抠到」和「这个商品确实没有」是两件事。
	if (extracted.price) payload.price = extracted.price;
	if (extracted.currency) payload.currency = extracted.currency;
	if (extracted.rating != null) payload.rating = extracted.rating;
	if (extracted.reviewCount != null)
		payload.reviewCount = extracted.reviewCount;
	if (extracted.salesRank != null) payload.salesRank = extracted.salesRank;
	if (extracted.inStock != null) payload.inStock = extracted.inStock;
	// 值和窗口**成对**才有意义：只有数字不知道是周还是月，没法比较也没法入库
	if (extracted.unitsSold != null && extracted.unitsSoldPeriod != null) {
		payload.unitsSold = extracted.unitsSold;
		payload.unitsSoldPeriod = extracted.unitsSoldPeriod;
	}

	// 规格原文原样带上，归一在入库侧做（契约 ①′）
	if (extracted.unitCount || extracted.itemForm) {
		payload.variantAttrs = {};
		if (extracted.itemForm) payload.variantAttrs.label = extracted.itemForm;
		if (extracted.unitCount) payload.variantAttrs.pack = extracted.unitCount;
	}

	return payload;
}
