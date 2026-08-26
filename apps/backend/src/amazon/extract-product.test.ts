import { describe, expect, it } from "vitest";
import {
	extractAplusText,
	extractCurrency,
	extractImages,
	extractIngredientsText,
	extractInStock,
	extractLabeledValue,
	extractPrice,
	extractRating,
	extractReviewCount,
	htmlToText,
	looksLikeIngredientList,
	normalizeIngredientName,
	regionAfterId,
	stripNoise,
	textOfElementById,
	tokenizeIngredients,
	extractOverviewIngredients,
	extractUnitsSold,
} from "./extract-product";

describe("成分段抽取", () => {
	// Amazon 的分节小标题不带冒号 —— 要求冒号只能命中 30%，按分节边界抠到 81%
	const page = `<div id="important-information" class="a-section">
		Important information Safety Information For adults only. Consult physician.
		Ingredients Vitamin B-6 (from Pyridoxine HCl), Folate DFE (folic acid), Zinc
		Directions Take one daily. Legal Disclaimer Statements not evaluated by FDA.
	</div>`;

	it("抠到 Ingredients 和下一个小标题之间的内容", () => {
		const text = extractIngredientsText(page);
		expect(text).toContain("Vitamin B-6");
		expect(text).toContain("Zinc");
		// 不能把下一节吞进来
		expect(text).not.toContain("Take one daily");
		expect(text).not.toContain("FDA");
	});

	it("没有冒号也能抠到 —— 这正是命中率从 30% 提到 81% 的原因", () => {
		expect(extractIngredientsText(page)).toBeTruthy();
	});

	it("带冒号的写法同样支持", () => {
		const html = `<div id="important-information">Ingredients: Magnesium Citrate, Rice Flour Directions daily</div>`;
		expect(extractIngredientsText(html)).toBe("Magnesium Citrate, Rice Flour");
	});

	it("太短的匹配当作误命中丢弃", () => {
		const html = `<div id="important-information">Ingredients none Directions x</div>`;
		expect(extractIngredientsText(html)).toBeNull();
	});

	it("没有该区块时返回 null，而不是空字符串", () => {
		expect(extractIngredientsText("<div>nothing here</div>")).toBeNull();
	});

	it("不被免责声明里句中的 `ingredients,` 骗到", () => {
		// Amazon 的固定免责句出现在真正的小标题**之前**，里面就有 "ingredients,"。
		// 不排除句中用法的话，非贪婪匹配会从这儿起头，把免责尾巴当成分抠进来 ——
		// 实测这是未命中榜首（200 份里 10 次 "labeling and allergen"）。
		const html = `<div id="important-information">
			This product is labelled to United States standards and may differ from
			similar products sold elsewhere in its ingredients, labeling and allergen warnings
			Ingredients Magnesium Citrate, Rice Flour
			Directions Take one daily.</div>`;
		const text = extractIngredientsText(html);
		expect(text).toBe("Magnesium Citrate, Rice Flour");
		expect(text).not.toContain("labeling");
		expect(text).not.toContain("allergen");
	});
});
describe("成分抠取的两个真实误匹配", () => {
	it("末尾断在标签中间的属性不能混进来", () => {
		// 实测 B0100US7HW：定长切片切到 4000 字处卡在标签中间，剩下没有配对 `>` 的
		// `<td class="a-size-ba`，剥标签的正则要求配对，剥不掉 —— 属性原样进了成分
		const html = `<div id="feature-bullets">Ingredients Zinc, Gelatin, Rice Flour <td class="a-size-ba`;
		const text = extractIngredientsText(html);
		expect(text).not.toContain("a-size-ba");
		expect(text).not.toContain("<td");
	});

	it("有更像成分表的候选时，不选句中用法那一处", () => {
		// 实测 B003UNHI2M：`premium grade ingredients. For the past 30 years…`
		// 被当成分抠走了。现在改成收集所有候选、优先挑像列表的。
		const html = `<div id="feature-bullets">made from premium grade ingredients. For the past 30 years, ScienceBased Health has been a leader in nutrition.
			Ingredients Zinc, Gelatin, Rice Flour Directions daily</div>`;
		expect(extractIngredientsText(html)).toBe("Zinc, Gelatin, Rice Flour");
	});

	it("整页只有句中用法时返回 null —— 宁可不给，也别把广告词当成分", () => {
		// 这里的 `ingredients.` 是句子的一部分，后面接的是品牌故事。早先的写法
		// 会把它整段交出去，理由是「让模型当最后一道闸」；实测推翻了这个理由：
		// 挡掉句中用法后覆盖率只从 84.5% 掉到 82.5%（169→165 条），而以标点
		// 开头的污染段从 11 条降到 0。丢的两个点本来就不是成分。
		const html = `<div id="feature-bullets">made from premium grade ingredients. For the past 30 years, ScienceBased Health has been a leader in developing evidence-based nutritional supplements trusted by doctors.</div>`;
		expect(extractIngredientsText(html)).toBeNull();
	});

	it("详情表是分节边界 —— 否则会一路冲进商品概览表", () => {
		// 实测抠到过 `Show more Item details Brand Name Sevenseas Primary Supplement Type…`
		const html = `<div id="important-information">Ingredients Zinc, Gelatin Show more Item details Brand Name Sevenseas</div>`;
		expect(extractIngredientsText(html)).toBe("Zinc, Gelatin");
	});

	it("一个页面里多处 ingredients 时，挑真正像成分表的那处", () => {
		const html = `<div id="important-information">
			crafted with premium ingredients. Our story began decades ago in a small family workshop where quality mattered above all else.
			Ingredients Magnesium Citrate, Rice Flour, Gelatin
			Directions daily</div>`;
		expect(extractIngredientsText(html)).toBe(
			"Magnesium Citrate, Rice Flour, Gelatin",
		);
	});
});

describe("extractOverviewIngredients —— 商品概览表兜底", () => {
	const row = (cls: string, label: string, value: string) =>
		`<tr class="a-spacing-small ${cls}" role="listitem"><td class="a-span3"><span class="a-size-base a-text-bold">${label}</span></td><td class="a-span9"><span class="a-size-base po-break-word">${value}</span></td></tr>`;

	it("抠 Active Ingredients，并把标签切掉只留值", () => {
		expect(
			extractOverviewIngredients(
				row("po-active_ingredients", "Active Ingredients", "sodium chloride"),
			),
		).toBe("sodium chloride");
	});

	it("Special Ingredients 也算 —— 两种写法都在真实页面上见过", () => {
		expect(
			extractOverviewIngredients(
				row("po-special_ingredients", "Special Ingredients", "Fish Oil"),
			),
		).toBe("Fish Oil");
	});

	it("多行合并成一段", () => {
		const html =
			row("po-active_ingredients", "Active Ingredients", "Psyllium") +
			row("po-special_ingredients", "Special Ingredients", "Inulin");
		expect(extractOverviewIngredients(html)).toBe("Psyllium, Inulin");
	});

	it("表里没有成分行时返回 null，不去碰别的行", () => {
		expect(
			extractOverviewIngredients(row("po-item_form", "Item Form", "Pellet")),
		).toBeNull();
	});

	it("只在主路径抠不到时兜底 —— 有完整成分表就不能被一个词顶掉", () => {
		const html = `<div id="important-information">Ingredients Zinc, Gelatin, Rice Flour Directions daily</div>${row("po-active_ingredients", "Active Ingredients", "Zinc")}`;
		expect(extractIngredientsText(html)).toBe("Zinc, Gelatin, Rice Flour");
	});

	it("主路径落空时才交出概览表的值", () => {
		const html = `<div id="feature-bullets">no mention here</div>${row("po-active_ingredients", "Active Ingredients", "sodium chloride")}`;
		expect(extractIngredientsText(html)).toBe("sodium chloride");
	});
});

describe("looksLikeIngredientList", () => {
	it("逗号分隔的短词组 = 成分表", () => {
		expect(looksLikeIngredientList("Zinc, Gelatin, Rice Flour")).toBe(true);
	});

	it("长句子 = 营销文案", () => {
		expect(
			looksLikeIngredientList(
				"For the past 30 years, ScienceBased Health has been a leader in developing evidence-based nutritional supplements trusted by doctors nationwide",
			),
		).toBe(false);
	});

	it("单个短成分名也算", () => {
		expect(looksLikeIngredientList("Organic Ceylon Cinnamon Bark Oil")).toBe(true);
	});

	it("单段但很长的当文案", () => {
		expect(looksLikeIngredientList("x".repeat(200))).toBe(false);
	});
});

describe("成分切词", () => {
	it("按逗号切，并去掉剂量和括号注释", () => {
		const out = tokenizeIngredients(
			"Vitamin B-6 (from Pyridoxine HCl) 25 mg, Zinc 15mg, Magnesium Citrate",
		);
		expect(out).toEqual(["vitamin b-6", "zinc", "magnesium citrate"]);
	});

	it("砍掉份量前缀", () => {
		const out = tokenizeIngredients(
			"Each Serving Size (1 capsule) contains: Spanish Moss, Bovine Prostate",
		);
		expect(out).toEqual(["spanish moss", "bovine prostate"]);
	});

	it("不在 and 上切 —— 会把一个短语劈成三段垃圾", () => {
		// 实测踩过：按 and 切产生了 "or palm with beeswax"、"or carnauba wax" 这种词
		const out = tokenizeIngredients(
			"blend of oils (coconut or palm) with beeswax and carnauba wax",
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("beeswax");
		expect(out[0]).toContain("carnauba wax");
	});

	it("挡掉明显不是成分的噪声词", () => {
		const out = tokenizeIngredients(
			"Other Ingredients, labeling, allergen, Gelatin, purity",
		);
		expect(out).toEqual(["gelatin"]);
	});

	it("空输入不炸", () => {
		expect(tokenizeIngredients("")).toEqual([]);
	});
});

describe("normalizeIngredientName", () => {
	it("统一大小写、去括号、去剂量", () => {
		expect(
			normalizeIngredientName("Vitamin D3 (as Cholecalciferol) 5000 IU"),
		).toBe("vitamin d3");
	});

	it("保留连字符 —— B-6 和 B6 在词表里是两个词条", () => {
		expect(normalizeIngredientName("Vitamin B-6")).toBe("vitamin b-6");
	});

	it("去掉末尾的 supplement —— 词表里存的是不带后缀的名字", () => {
		// 强化食品配料表写 "Niacin Supplement"，词表里是 "Niacin"，不去后缀全落空
		expect(normalizeIngredientName("Niacin Supplement")).toBe("niacin");
		expect(normalizeIngredientName("Vitamin D3 Supplement")).toBe("vitamin d3");
	});

	it("只去末尾的，词中间的 supplement 不动", () => {
		expect(normalizeIngredientName("Supplement Blend Extract")).toBe(
			"supplement blend extract",
		);
	});
});

describe("价格", () => {
	it("拼接整数和小数两个 span", () => {
		const html = `<span class="a-price-whole">10<span class="a-price-fraction">76</span>`;
		expect(extractPrice(html)).toBe("10.76");
	});

	it("千分位逗号去掉", () => {
		expect(extractPrice(`<span class="a-price-whole">1,299`)).toBe("1299");
	});

	it("只有整数部分时不补小数", () => {
		expect(extractPrice(`<span class="a-price-whole">24`)).toBe("24");
	});

	it("没有价格返回 null", () => {
		expect(extractPrice("<div>no price</div>")).toBeNull();
	});

	it("符号转 ISO 币种码", () => {
		expect(extractCurrency(`<span class="a-price-symbol">$</span>`)).toBe(
			"USD",
		);
		expect(extractCurrency(`<span class="a-price-symbol">£</span>`)).toBe(
			"GBP",
		);
	});

	it("不认识的符号返回 null，不瞎猜", () => {
		expect(extractCurrency(`<span class="a-price-symbol">₹</span>`)).toBeNull();
	});
});

describe("评分与评论数", () => {
	it("裸的 a-icon-alt 不算 —— 必须在主商品评分区里", () => {
		// 旧实现取整页第一个 a-icon-alt，命中率 100% 很好看，但 25.5% 是错的
		// （见下一条）。命中率高不等于对，这条测试当年只验了「有值」。
		expect(extractRating('<span class="a-icon-alt">4.6 out of 5 stars</span>')).toBeNull();
		expect(
			extractRating('<div id="averageCustomerReviews"><span class="a-icon-alt">4.6 out of 5 stars</span></div>'),
		).toBe(4.6);
	});

	it("主商品无评价时不借用别处的星级 —— 推荐位/单条评论都不算", () => {
		// 实测 25.5% 的页面栽在这儿：主商品没人评价，整页首个 a-icon-alt 来自
		// 推荐商品或某条用户评论，于是给这个商品凭空造了个评分出来
		const html = `<div id="productTitle">Some Product</div>
			<a href="/dp/B0CLHJDVWR"><i class="a-icon a-star-small-4">
			  <span class="a-icon-alt">4.2 out of 5 stars</span></i></a>
			<i class="a-icon cr-lightbox-review-rating">
			  <span class="a-icon-alt">5.0 out of 5 stars</span></i>`;
		expect(extractRating(html)).toBeNull();
	});

	it("锚定到主商品评分区", () => {
		const html = `<a href="/dp/B0OTHER"><span class="a-icon-alt">4.2 out of 5 stars</span></a>
			<div id="averageCustomerReviews"><span class="a-icon-alt">3.8 out of 5 stars</span></div>`;
		expect(extractRating(html)).toBe(3.8);
	});

	it("acrPopover 是备选写法", () => {
		expect(
			extractRating('<span id="acrPopover" title="4.7 out of 5 stars">x</span>'),
		).toBe(4.7);
	});

	it("评分区内有多个星级时取第一个 —— 区外的一概不看", () => {
		const html = `<span class="a-icon-alt">9.9 out of 5 stars</span>
			<div id="averageCustomerReviews">
			  <span class="a-icon-alt">4.6 out of 5 stars</span>
			  <span class="a-icon-alt">3.1 out of 5 stars</span></div>`;
		expect(extractRating(html)).toBe(4.6);
	});

	it("越界的分数丢弃", () => {
		expect(
			extractRating(`<span class="a-icon-alt">9.9 out of 5 stars</span>`),
		).toBeNull();
	});

	it("优先 global ratings", () => {
		expect(extractReviewCount("<div>5,588 global ratings</div>")).toBe(5588);
	});

	it("退回泛化的 ratings 写法", () => {
		expect(extractReviewCount("<div>2,098 ratings</div>")).toBe(2098);
	});

	it("没有评论数返回 null", () => {
		expect(extractReviewCount("<div>no reviews yet</div>")).toBeNull();
	});
});

describe("图片", () => {
	it("从 hiRes 取（landingImage 在存档里 0/40）", () => {
		const html = `{"hiRes":"https://m.media-amazon.com/images/I/91Fy.jpg"}`;
		expect(extractImages(html)).toEqual([
			"https://m.media-amazon.com/images/I/91Fy.jpg",
		]);
	});

	it("去重并限量", () => {
		const one = `{"hiRes":"https://x/a.jpg"}`;
		const two = `{"hiRes":"https://x/b.jpg"}`;
		expect(extractImages(`${one}${one}${two}`)).toEqual([
			"https://x/a.jpg",
			"https://x/b.jpg",
		]);
	});

	it("还原转义的斜杠", () => {
		expect(
			extractImages(`{"hiRes":"https:\\u002F\\u002Fx\\u002Fa.jpg"}`),
		).toEqual(["https://x/a.jpg"]);
	});
});

describe("库存与带标签的字段", () => {
	it("识别在售", () => {
		expect(
			extractInStock(`<div id="availability"><span>In Stock</span></div>`),
		).toBe(true);
	});

	it("识别缺货", () => {
		expect(
			extractInStock(
				`<div id="availability"><span>Currently unavailable</span></div>`,
			),
		).toBe(false);
	});

	it("没有该区块时返回 null，不臆断为有货", () => {
		expect(extractInStock("<div>whatever</div>")).toBeNull();
	});

	it("取 Item Form 并剥掉方向标记字符", () => {
		const html = `<span>Item Form</span><span>‏ ‎ Gelcap</span>`;
		expect(extractLabeledValue(html, "Item Form")).toBe("Gelcap");
	});
});

describe("营销文案 —— 语义清洗的原料", () => {
	// healthFunctions 和缺失的 productForm 在 Amazon 上没有对应字段，
	// 只散落在文案里靠模型推断。格式化清洗把文案压没了，下游就无米下锅。
	it("A+ 模块用 id 前缀搜 —— aplus 和 aplus_feature_div 两种写法都有", () => {
		expect(
			extractAplusText(
				`<div id="aplus_feature_div">${"Supports immune health and energy. ".repeat(3)}</div>`,
			),
		).toContain("immune health");
		expect(
			extractAplusText(
				`<div id="aplus">${"Clinically studied formula for joint comfort. ".repeat(3)}</div>`,
			),
		).toContain("joint comfort");
	});

	it("内容太短当作没有 —— 空壳容器不算原料", () => {
		expect(extractAplusText(`<div id="aplus_feature_div"> </div>`)).toBeNull();
	});

	it("没有 A+ 模块返回 null", () => {
		expect(extractAplusText("<div>nothing</div>")).toBeNull();
	});
});

describe("regionAfterId", () => {
	it("跳过开标签的剩余属性 —— 否则属性会被当成文本", () => {
		// 实测踩到：产品名被抠成
		// `id="productTitle" class="a-size-large ...> 真正的标题`
		// 而「命中率 100%」那个测量只验非空，验不出这个。
		const html = `<span id="productTitle" class="a-size-large product-title-word-break">NOW Foods Zinc</span>`;
		const region = regionAfterId(html, "productTitle", 500);
		expect(region).not.toContain("a-size-large");
		expect(htmlToText(region)).toBe("NOW Foods Zinc");
	});

	it("找不到 id 时返回空串", () => {
		expect(regionAfterId("<div>x</div>", "nope", 100)).toBe("");
	});

	it("开标签异常长时退回原位，不切到错误位置", () => {
		const weird = `id="x"${" ".repeat(3000)}>tail`;
		expect(regionAfterId(weird, "x", 20).startsWith('id="x"')).toBe(true);
	});
});

describe("textOfElementById", () => {
	it("只取元素内部文本，不冲过闭合标签", () => {
		// 实测踩到：定长切片把标题后面的 byline 元素也吞进来，抠成
		// `Full Focus Leather Planner (Saddle) <a id="bylineIn`
		const html = `<span id="productTitle" class="a-size-large">Full Focus Planner</span><a id="bylineInfo" href="/x">Visit the Store</a>`;
		expect(textOfElementById(html, "productTitle")).toBe("Full Focus Planner");
	});

	it("找不到 id 返回 null", () => {
		expect(textOfElementById("<div>x</div>", "nope")).toBeNull();
	});

	it("内容为空时返回 null 而不是空串", () => {
		expect(textOfElementById(`<span id="t">   </span>`, "t")).toBeNull();
	});

	it("没有闭合标签时按 maxSpan 截断，不无限吞", () => {
		const html = `<span id="t">${"x".repeat(5000)}`;
		expect(textOfElementById(html, "t", 100)?.length).toBeLessThanOrEqual(100);
	});
});

describe("stripNoise", () => {
	it("去掉 script 和 style —— 里面的 JSON/CSS 会污染所有文本匹配", () => {
		const html = `<script>var x="Ingredients: fake"</script><style>.a{}</style><p>real</p>`;
		const out = stripNoise(html);
		expect(out).not.toContain("fake");
		expect(out).toContain("real");
	});
});

describe("extractUnitsSold —— 近期销量", () => {
	it("抠出数值和窗口", () => {
		expect(extractUnitsSold("100+ bought in past month")).toEqual({
			value: 100,
			period: "month",
		});
	});

	it("week 也要认 —— 实测 400 份里 260 次是 week、只有 90 次是 month", () => {
		// 只匹配 month 会丢掉四分之三的数据
		expect(extractUnitsSold("200+ bought in past week")).toEqual({
			value: 200,
			period: "week",
		});
	});

	it("K 后缀展开成整数", () => {
		expect(extractUnitsSold("2K+ bought in past week")).toEqual({
			value: 2000,
			period: "week",
		});
	});

	it("小数 K 也对 —— 1.5K = 1500", () => {
		expect(extractUnitsSold("1.5K+ bought in past month")?.value).toBe(1500);
	});

	it("千分位逗号去掉", () => {
		expect(extractUnitsSold("1,000+ bought in past month")?.value).toBe(1000);
	});

	it("sold / purchased 的说法也认", () => {
		expect(extractUnitsSold("50+ sold in past month")?.value).toBe(50);
		expect(extractUnitsSold("50+ purchased in the past week")?.period).toBe("week");
	});

	it("页面没有销量文案时返回 null", () => {
		expect(extractUnitsSold("<div>no sales copy here</div>")).toBeNull();
	});

	it("不认没有时间窗口的句子 —— 两个窗口不可比，缺一不可", () => {
		expect(extractUnitsSold("100+ bought")).toBeNull();
	});
});
