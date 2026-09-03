/**
 * 格式化清洗：把存档的商品页 HTML 抠成结构化字段。
 *
 * **纯函数、零依赖、零 token** —— 这一步不碰模型。实测整页 HTML 平均 1.85 MB，
 * 抠完约 1.5 KB，压缩 **1228 倍**。语义化清洗（成分归一到词表）的成本完全取决于
 * 这一步压得多干净，所以能用规则解决的绝不留给模型。
 *
 * 所有正则都是对 40 份真实存档实测过的，注释里的命中率不是估的。
 * 换用别的写法前先去存档上量一遍 —— Amazon 同一个字段有好几种 DOM 写法，
 * 挑错分支的代价是静默少抠一半数据（上架日期就踩过：42% vs 90%）。
 */

import { extractHtmlFacts } from "../dtc/html-facts.js";
import { extractBrand, extractProductDetails } from "./link-check.js";

export interface ExtractedProduct {
	title: string | null;
	brand: string | null;
	/** 价格字符串（保留原始精度，不转 number —— 契约要的就是 string） */
	price: string | null;
	/** ISO 4217；从页面上的符号推的，推不出就 null */
	currency: string | null;
	rating: number | null;
	reviewCount: number | null;
	salesRank: number | null;
	inStock: boolean | null;
	images: string[];
	/**
	 * 页面自己标注为成分表/标签的图（alt/文件名含 supplement facts、nutrition label 等）。
	 * 实测 600 个真实页面里 18.3% 能指认出来——OCR 时先只跑这些，读到就停，省掉整轮画廊 OCR。
	 * 页面成分表**文字**在 Amazon 上实测 0%（见下方 ingredientsText 的注释），所以只取图不取表。
	 */
	factsImageUrls?: string[];
	/** Amazon 的 "Item Form"：Gelcap / Tablet / Powder… */
	itemForm: string | null;
	/** Amazon 的 "Unit Count"：如 "90 Count" */
	unitCount: string | null;
	dateFirstAvailable: string | null;
	manufacturer: string | null;
	/**
	 * 近期销量（`"50+ bought in past month"` 里的数字）。
	 *
	 * ⚠️ 是**近似下界**不是精确值：Amazon 只给 `50+` / `2K+` 这种档位。
	 * 拿它做趋势和排序可以，当成真实销量会高估精度。
	 */
	unitsSold: number | null;
	/** 销量对应的窗口：`"week"` | `"month"` —— 两种都常见，不能只认一种 */
	unitsSoldPeriod: string | null;
	/**
	 * 成分段原文（未切词）。
	 *
	 * ⚠️ 这是**配料名单**，不是营养成分表 —— 没有剂量、没有 %DV、没有每份含量。
	 * 实测只有 **5%** 的页面把 supplement facts 写成文本，其余全在图片里，
	 * 所以剂量数据必须靠 OCR（文档 D3：以标签图片为主源，且 OCR 在库外）。
	 * 我们这一步只负责交出名单和图片，剂量走 `submitFacts` 端点。
	 */
	ingredientsText: string | null;
	/** 切好的候选成分名，供词表匹配 */
	ingredients: string[];

	/**
	 * ── 营销文案：语义化清洗的原料 ────────────────────────────────────
	 *
	 * `healthFunctions`（功效）和缺失的 `productForm` 在 Amazon 上**没有对应
	 * 字段**，只散落在这些文案里，靠模型推断。所以格式化清洗不能只留结构化
	 * 字段就把文案压没了 —— 那等于把下游要用的原料一起扔了。
	 *
	 * 实测覆盖率：bullets 98%、描述 93%、A+ 100%，合计约 4,000 字符
	 * （≈1,000 token）。这是压缩比从 1087x 降到约 300x 的原因，值得。
	 */
	bullets: string | null;
	description: string | null;
	/** 品牌自定义的 A+ 图文模块，功效描述常在这里 */
	aplusText: string | null;
}

// ── HTML 工具 ────────────────────────────────────────────────────────────

/** 去掉 script/style —— 它们里面全是 JSON 和 CSS，会污染所有文本匹配 */
export function stripNoise(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ");
}

export function htmlToText(html: string): string {
	return (
		html
			// ⚠️ 先砍掉**末尾不完整的标签**。定长切片经常正好断在标签中间，剩下
			// 一个没有配对 `>` 的 `<td class="a-size-ba`，下面那条剥标签的正则
			// 要求配对，剥不掉，属性就原样混进文本 —— 实测成分被抠成
			// `Show more Item details Brand Name <td class="a-size-ba`。
			.replace(/<[^>]*$/, " ")
			.replace(/<[^>]+>/g, " ")
	)
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#\d+;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * 取 id 元素往后的一段。粗糙但够用 —— 我们要的是文本，不是 DOM 树。
 *
 * ⚠️ 必须**跳过开标签的剩余部分**再开始切。从 `id="..."` 处直接切，切点落在
 * 标签内部，后面的 `class="..." data-...>` 没有前导 `<`，htmlToText 剥不掉，
 * 会原样混进文本里 —— 实测产品名被抠成
 * `id="productTitle" class="a-size-large ...> 真正的标题`，而「命中率 100%」
 * 那个测量只验了非空、验不出这个。
 */
export function regionAfterId(html: string, id: string, span: number): string {
	const i = html.indexOf(`id="${id}"`);
	if (i < 0) return "";
	const gt = html.indexOf(">", i);
	// 正常开标签不会太长；找不到或离谱地远就退回原位，宁可多几个字符也别切错位置
	const start = gt >= 0 && gt - i < 2000 ? gt + 1 : i;
	return html.slice(start, start + span);
}

/**
 * 取 id 元素的**内部文本** —— 到第一个闭合标签为止。
 *
 * 和 regionAfterId 的区别：那个取定长切片，会冲过闭合标签把后面的元素吞进来。
 * 实测产品名因此被抠成 `Full Focus Leather Planner (Saddle) <a id="bylineIn`
 * —— 切到 800 字处正好卡在下一个标签中间，`<` 没有配对的 `>`，剥不掉。
 *
 * 只适用于**内部没有嵌套标签**的元素（productTitle 就是个纯 span）。
 * 需要整段区域时仍用 regionAfterId。
 */
export function textOfElementById(
	html: string,
	id: string,
	maxSpan = 2000,
): string | null {
	const i = html.indexOf(`id="${id}"`);
	if (i < 0) return null;
	const gt = html.indexOf(">", i);
	if (gt < 0) return null;
	const close = html.indexOf("</", gt);
	const stop = close >= 0 && close - gt < maxSpan ? close : gt + maxSpan;
	return htmlToText(html.slice(gt + 1, stop)) || null;
}

// ── 成分 ─────────────────────────────────────────────────────────────────

/**
 * Amazon 的 "Important information" 区块用**不带冒号**的小标题分节：
 *
 *   Safety Information  …
 *   Ingredients         Vitamin B-6 (from Pyridoxine HCl), Folate DFE…
 *   Directions          …
 *   Legal Disclaimer    …
 *
 * 所以要抠到「下一个小标题为止」，而不是找 `Ingredients:`。
 * 实测差别巨大：要求冒号只有 **30%** 命中，改成分节边界后 **81%**。
 */
const SECTION_HEADINGS = [
	"Directions",
	"Legal Disclaimer",
	"Safety Information",
	"Indications",
	"Warnings",
	"Statements regarding",
	"Product description",
	"Disclaimer",
	// 详情表的入口。important-information 区没有明确结尾，定长切片会一路冲进
	// 下面的商品概览表，抠出 `Show more Item details Brand Name Sevenseas …`
	// 这种东西（实测 100 条里 3 条）。
	"Show more",
	"Item details",
].join("|");

/**
 * ⚠️ `(?!\s*[.,;!?)])` 不是可有可无的 —— 它把**句子里的** ingredients 挡掉。
 *
 * 小标题后面跟的是成分本身，绝不会紧跟标点。句中用法则必然带标点收尾：
 *
 *   `…in its **ingredients,** labeling and allergen warnings`   ← 固定免责声明
 *   `…made with gluten free **ingredients.** Family owned since 1968.`
 *
 * 两种都会让非贪婪匹配从句中起头，把后面的广告词当成分抠走。只挡逗号时
 * 实测仍有 **6.5%**（169 条里 11 条）以 `". "` 开头；补上句号等标点后归零。
 */
const INGREDIENTS_RE = new RegExp(
	`\\bIngredients\\b(?!\\s*[.,;!?)])\\s*[:：]?\\s*(.+?)(?=\\s*(?:${SECTION_HEADINGS})\\b|$)`,
	"is",
);


/** 明显不是成分名的整段噪声 —— 切出来也没用，先挡掉 */
const NOISE_TOKENS =
	/^(other ingredients?|ingredients?|proprietary blend|daily value|serving size|contains|includes?|per serving|see packaging for ingredients|labeling|allergen|purity|travel|color|fillers|none|n\/a)$/i;

/**
 * 成分名归一：小写、去括号注释、去剂量、折叠空格。
 *
 * 末尾的 `supplement` 也要去 —— 强化食品的配料表写成 "Niacin Supplement"、
 * "Vitamin D3 Supplement"，而词表里存的是 "Niacin"、"Vitamin D3"。
 * 不去掉的话这类词全部落空（实测未命中榜上连着好几条都是这个后缀）。
 */
export function normalizeIngredientName(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/\([^)]*\)/g, " ")
		.replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|iu|ml|%|billion|cfu)\b/g, " ")
		.replace(/[^a-z0-9\s-]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\s+supplement$/, "");
}

/**
 * 把成分段切成候选名。
 *
 * ⚠️ **不在 `and` 上切**。实测按 `and` 切会把 "blend of oils (coconut or palm)
 * with beeswax and carnauba wax" 劈成三段全是垃圾。逗号/分号/顿号已经够用，
 * 少切几刀好过切碎 —— 切碎的词永远匹配不上词表，还会把覆盖率统计带偏。
 */
export function tokenizeIngredients(text: string): string[] {
	return (
		text
			// 砍掉份量前缀："Each Serving Size (1 capsule) contains:"
			.replace(/^.*?\bcontains\b\s*[:：]?/i, "")
			.split(/[,;•·]/)
			.map(normalizeIngredientName)
			.filter((t) => t.length > 2 && t.length < 60)
			.filter((t) => !NOISE_TOKENS.test(t))
	);
}

/**
 * 判断一段文本**读起来像不像成分表**。
 *
 * 成分表是「逗号分隔的短词组」；营销文案是「长句子」。用这个区分能挡住
 * 句中 `ingredients` 引出的误匹配 —— 实测抠到过
 * `"For the past 30 years, ScienceBased Health has been a leader in…"`
 * 这种整段广告词。
 *
 * 只在拿不准时用：真成分表几乎必然逗号密集（`Zinc, Gelatin, Rice Flour`）。
 */
export function ingredientListScore(text: string): number {
	const segments = text
		.split(/[,;]/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (segments.length < 2) {
		// 单段也可能是真的（"Organic Ceylon Cinnamon Bark Oil"），但必须够短
		return text.length <= 80 ? 1 : 99;
	}
	// ⚠️ 用**中位数**，不是平均值也不是最大值。三个都试过：
	//
	//   平均值 → 太松。". Our story began decades ago… Magnesium Citrate,
	//            Rice Flour, Gelatin" 被两个短段稀释到 45，照样过关。
	//   最大值 → 太紧。真成分表常带长前缀（"Each Serving Size (1 capsule)
	//            contains: Proprietary Blend 270 mg: Spanish moss …" 有 15 个词），
	//            一段就把整条否掉 —— 实测覆盖率从 84.5% 崩到 66.5%。
	//   中位数 → 刚好。长前缀只占一段，拉不动中位；而整段广告词是**每段都长**。
	const words = segments
		.map((s) => s.split(/\s+/).filter(Boolean).length)
		.sort((a, b) => a - b);
	const mid = words.length >> 1;
	return words.length % 2
		? (words[mid] as number)
		: ((words[mid - 1] as number) + (words[mid] as number)) / 2;
}

/** 分数越低越像成分表；6 是实测的分界（真列表中位 1~4，广告词 8+）。 */
export function looksLikeIngredientList(text: string): boolean {
	return ingredientListScore(text) <= 6;
}

export function extractIngredientsText(html: string): string | null {
	const blob = [
		regionAfterId(html, "important-information", 9000),
		regionAfterId(html, "feature-bullets", 4000),
	]
		.map(htmlToText)
		.join(" ");

	// 收集所有候选，**优先挑像成分表的**；一个都不像时退回第一个。
	//
	// 为什么不直接把不像的丢掉：实测那样覆盖率从 84.5% 掉到 66.5%，
	// 而挡掉的垃圾**模型本来就能识别**（两条误匹配都返回了空数组，一条都没进库）。
	// 用 18 个百分点的真数据去换模型已经挡住的东西，不划算 —— 让模型当最后一道闸。
	//
	// ⚠️ 不能用 matchAll 跑整条正则 —— 第一个匹配会一直吞到下一个小标题，
	// 正则位置越过了后面真正的 Ingredients 小标题，第二处再也匹配不到。
	// 必须先定位所有关键词出现处，再从每处**独立**往后抠。
	// ⚠️ 取**分数最低的**，不是第一个通过阈值的。句中用法那一处会把后面真正的
	// 列表一起吞进来，里面的短段把中位数拉低，照样"通过" —— 实测抠到
	// `". For the past 30 years, … Ingredients Zinc, Gelatin, Rice Flour"`。
	// 而真正的小标题那一处只有干净的列表，分数必然更低。
	let best: string | null = null;
	let bestScore = Number.POSITIVE_INFINITY;

	for (const m of blob.matchAll(/\bIngredients\b/gi)) {
		const at = m.index;
		if (at === undefined) continue;
		const raw = blob.slice(at).match(INGREDIENTS_RE)?.[1]?.trim();
		// 太短多半是误匹配到标题，太长多半是把整段免责声明吞进来了
		if (!raw || raw.length < 8 || raw.length > 3000) continue;
		// 同分时取更短的 —— 更短意味着前面的废话更少
		const score = ingredientListScore(raw);
		if (score < bestScore || (score === bestScore && best && raw.length < best.length)) {
			best = raw;
			bestScore = score;
		}
	}
	return best ?? extractOverviewIngredients(html);
}

/**
 * 兜底：商品概览表里的 `Active Ingredients` / `Special Ingredients` 行。
 *
 * 和上面那条路完全不同 —— 这是**带标签的结构化字段**，不用猜边界，值也干净
 * （实测就是 `Psyllium`、`sodium chloride`、`Fish Oil` 这样的单个成分名）。
 *
 * 只当兜底：27% 的页面有这个块，但绝大多数主路径已经抠到了更完整的成分表，
 * 净增益只有约 **1.5%**（200 份里 1 份、另一批 28 份里 2 份）。抢在主路径
 * 前面用会把完整列表换成一个词，得不偿失。
 */
export function extractOverviewIngredients(html: string): string | null {
	const parts: string[] = [];
	for (const m of html.matchAll(
		/po-[a-z_]*ingredients"[^>]*>([\s\S]{0,600}?)<\/tr>/gi,
	)) {
		// 行文本形如 `Active Ingredients sodium chloride` —— 标签和值都在里面，
		// 把标签切掉只留值。
		const text = htmlToText(m[1] ?? "");
		const value = text.replace(/^.*?\bIngredients\b\s*/i, "").trim();
		if (value.length >= 3 && value.length <= 300) parts.push(value);
	}
	return parts.length > 0 ? parts.join(", ") : null;
}

// ── 单字段抽取（命中率均为 40 份真实存档实测）──────────────────────────

/** 87.5% —— 整数部分和小数部分是两个 span，要拼 */
export function extractPrice(html: string): string | null {
	const whole = html.match(/class="a-price-whole">([\d,]+)/)?.[1];
	if (!whole) return null;
	const frac = html.match(/class="a-price-fraction">(\d+)/)?.[1];
	const n = whole.replace(/,/g, "");
	return frac ? `${n}.${frac}` : n;
}

const SYMBOL_TO_ISO: Record<string, string> = {
	$: "USD",
	"£": "GBP",
	"€": "EUR",
	"¥": "JPY",
};

/** 87.5% */
export function extractCurrency(html: string): string | null {
	const sym = html.match(/class="a-price-symbol">([^<]{1,3})/)?.[1]?.trim();
	return sym ? (SYMBOL_TO_ISO[sym] ?? null) : null;
}

/**
 * 100% —— `a-icon-alt` 比 `acrPopover` 的 title 更可靠（后者只有 82.5%）。
 * 取第一个：页面底部「相关商品」也有星级，会覆盖成别人的分数。
 */
export function extractRating(html: string): number | null {
	// ⚠️ **必须锚定到主商品的评分区，不能在整页里取第一个星级。**
	//
	// 整页首个 `a-icon-alt` 命中率 100%，看着漂亮，实际有 **25.5%** 是抠错的 ——
	// 主商品压根没人评价时，第一个星级来自别处：
	//   `pd_rd_i=B0CLHJDVWR`      推荐位商品（另一个 ASIN）的评分
	//   `/product-reviews/B07NRT…` 又是别的商品
	//   `cr-lightbox-review-rating` 某一条用户评论自己的打分
	// 三种都在 productTitle **之后**，所以「取第一个」这条经验在无评价页上失效。
	//
	// 锚定后命中 74.5%，和评论数的 74.5% **完全吻合** —— 两者本来就成对出现，
	// 对不上就说明有一边在造数据。两法都有值时分歧 0 条，锚定不会引入新错误。
	for (const id of ["averageCustomerReviews", "acrPopover"]) {
		// ⚠️ 从 id 出现处切，**不能用 regionAfterId** —— 那个跳到 `>` 之后，
		// 而 acrPopover 把评分放在开标签的 title 属性里
		// （`<span id="acrPopover" title="4.7 out of 5 stars">`），跳过去就没了。
		// 这里是拿正则找特定形状，不是抽文本，属性混进来无害。
		const at = html.indexOf(`id="${id}"`);
		if (at < 0) continue;
		const region = html.slice(at, at + 3000);
		const m = region.match(/([\d.]+) out of 5 stars/);
		if (!m?.[1]) continue;
		const n = Number(m[1]);
		if (Number.isFinite(n) && n >= 0 && n <= 5) return n;
	}
	return null;
}

/**
 * 97.5% —— `acrCustomerReviewText` 在存档里一次都没出现（0/40），
 * 别照 Amazon 文档写。优先 "global ratings"（更精确），退回泛化的 "ratings"。
 */
export function extractReviewCount(html: string): number | null {
	const text = htmlToText(html);
	const raw =
		text.match(/([\d,]+)\s+global ratings?/i)?.[1] ??
		text.match(/([\d,]+)\s+ratings?\b/i)?.[1];
	if (!raw) return null;
	const n = Number(raw.replace(/,/g, ""));
	return Number.isInteger(n) && n >= 0 ? n : null;
}

/** `landingImage` 在存档里 0/40，图片地址在 JSON 里的 `hiRes`。默认保留完整画廊供 OCR。 */
export function extractImages(html: string, limit = Number.POSITIVE_INFINITY): string[] {
	const urls = [...html.matchAll(/"hiRes":"(https:[^"]+)"/g)].map((m) =>
		m[1]!.replace(/\\u002F/g, "/"),
	);
	return [...new Set(urls)].slice(0, limit);
}

/** 80% */
export function extractInStock(html: string): boolean | null {
	const region = regionAfterId(html, "availability", 300);
	if (!region) return null;
	const t = htmlToText(region);
	if (/in stock/i.test(t)) return true;
	if (/unavailable|out of stock/i.test(t)) return false;
	return null;
}

/**
 * A+ 图文模块（品牌自定义内容）。id 形如 `aplus_feature_div` / `aplus`，
 * 用前缀搜而不是精确 id —— 实测两种写法都出现过。
 */
export function extractAplusText(html: string, span = 20000): string | null {
	const i = html.search(/id="aplus[_"]/);
	if (i < 0) return null;
	const t = htmlToText(html.slice(i, i + span));
	return t.length > 50 ? t : null;
}

/** 从「产品信息」表里取一个带标签的值。Item Form 92.5%、Unit Count 55% */
export function extractLabeledValue(
	html: string,
	label: string,
): string | null {
	const re = new RegExp(
		`${label}[\\s\\S]{0,200}?<span[^>]*>([^<]{1,60})</span>`,
		"i",
	);
	const v = htmlToText(html.match(re)?.[1] ?? "");
	// Amazon 会在值前面塞方向标记字符（‏‎），不去掉会带进库里
	const cleaned = v.replace(/^[\s:‏‎]+/, "").trim();
	return cleaned || null;
}

// ── 近期销量 ──────────────────────────────────────────────────────────────

/**
 * `"50+ bought in past month"` → `{ value: 50, period: "month" }`。实测 400 份
 * 存档命中 **87.5%**。
 *
 * ⚠️ **window 有 week 和 month 两种，不能只认一种** —— 实测 260 次 week、
 * 90 次 month，只匹配 month 会丢掉四分之三。两者不可比，所以窗口必须一起存
 * （库里 `units_sold` 和 `units_sold_period` 就是配套的两列）。
 *
 * ⚠️ 值是**近似下界**：Amazon 只给 `50+` / `2K+` 这种档位，`2K+` 记 2000。
 * 排序和趋势能用，当精确销量会高估精度。
 */
export function extractUnitsSold(
	html: string,
): { value: number; period: string } | null {
	const m = html.match(
		/([\d,.]+)\s*(K|M)?\+?\s*(?:bought|sold|purchased)\s+in\s+(?:the\s+)?past\s+(week|month)/i,
	);
	// 分组：1=数字 2=K/M 3=窗口。中间那几个是 (?:) 非捕获组，不占编号。
	if (!m?.[1] || !m[3]) return null;
	const n = Number.parseFloat(m[1].replace(/,/g, ""));
	if (!Number.isFinite(n)) return null;
	const mult = m[2]?.toUpperCase() === "M" ? 1e6 : m[2]?.toUpperCase() === "K" ? 1000 : 1;
	return { value: Math.round(n * mult), period: m[3].toLowerCase() };
}

// ── 汇总 ─────────────────────────────────────────────────────────────────

/**
 * 整页 HTML → 结构化字段。
 *
 * 传进来的应当是**整页原始 HTML**，不是渲染后的可见文本 —— 详情区折叠时
 * innerText 是空的，上架日期实测因此只抠到 42%（改整页后 90%）。
 */
export function extractProduct(html: string): ExtractedProduct {
	const clean = stripNoise(html);
	const details = extractProductDetails(html);
	const brand = extractBrand(html);
	const ingredientsText = extractIngredientsText(clean);
	// 销量文案在可见文本里，clean（去了 script/style）足够
	const sold = extractUnitsSold(clean);

	return {
		// 用 textOfElementById 而不是 regionAfterId —— 定长切片会把标题后面的
		// 元素一起吞进来（见该函数注释里的实测例子）
		title: textOfElementById(clean, "productTitle", 800),
		brand: brand?.name ?? null,
		price: extractPrice(clean),
		currency: extractCurrency(clean),
		rating: extractRating(clean),
		reviewCount: extractReviewCount(clean),
		salesRank: details.bestSellersRank,
		inStock: extractInStock(clean),
		images: extractImages(html),
		factsImageUrls: extractHtmlFacts(html, "https://www.amazon.com/").factsImageUrls,
		itemForm: extractLabeledValue(clean, "Item Form"),
		unitCount: extractLabeledValue(clean, "Unit Count"),
		dateFirstAvailable: details.dateFirstAvailable,
		manufacturer: details.manufacturer,
		unitsSold: sold?.value ?? null,
		unitsSoldPeriod: sold?.period ?? null,
		ingredientsText,
		ingredients: ingredientsText ? tokenizeIngredients(ingredientsText) : [],
		bullets: htmlToText(regionAfterId(clean, "feature-bullets", 6000)) || null,
		description:
			htmlToText(regionAfterId(clean, "productDescription", 8000)) || null,
		aplusText: extractAplusText(clean),
	};
}
