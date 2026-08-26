/**
 * Amazon 品牌搜索页的抓取与解析。
 *
 * URL 形如：/s?k=<品牌>&rh=p_89:<品牌>&s=date-desc-rank
 * - `s=date-desc-rank` 就是页面上的 Newest Arrivals，排序真实有效
 *   （实测第 1 页全是 B0HB 新号段，第 7 页 18/22 是 B00/B01 十年前号段）
 * - `p_89` 是品牌硬过滤，实测 48/48 命中
 *
 * 页面里只负责把原始卡片捞出来，过滤和校验放在这边 —— 那部分才需要被测试。
 */

/**
 * 单次搜索最多 7 页；实际能拿到的是 **306 条**（6 页满 48 + 第 7 页 18）。
 *
 * ⚠️ 这是 **Amazon 全站的分页上限，不是我们的选择**。2026-08-12 实测：用最朴素
 * 的 `k=vitamin`（无品牌过滤、无自定义排序、号称 over 70,000 results）结果完全
 * 一样 —— 第 1 页的分页控件就只显示到 7，第 7 页 `289-306` 且没有「下一页」，
 * 第 8 页 0 条、页码行 `337-306`（起点 `(8-1)×48+1` 大于被卡住的终点）。
 *
 * 别拿「库里 16 个品牌都停在 306」当证据 —— 那是这个常量自己造成的，属于循环
 * 论证。真正的证据是第 7 页上那个只到 7 的分页器。
 *
 * 影响有限：79.2% 的品牌一页就扫完，只有 28 个大品牌触顶；且不影响「发现上新」
 * （按最新排序时新品必在最前几页），只影响「扒全历史库存」。绕法是加 facet 切分
 * 让每个查询各享 306 额度，见 SUPPLYSMAR-251 与 docs/apps/link-monitor/。
 */
export const MAX_SEARCH_PAGES = 7;
export const RESULTS_PER_PAGE = 48;

export interface RawTile {
	asin: string;
	title: string;
	sponsored: boolean;
}
export interface RawSearchPage {
	tiles: RawTile[];
	/** 页面被反爬拦下时为 true —— 这时候 tiles 为空不代表「该品牌没商品」。 */
	blocked: boolean;
	title: string;
}

export interface SearchResult {
	asin: string;
	title: string;
	/** 标题里能不能看到品牌名。只作观测信号，不用来丢数据（见下）。 */
	titleMatchesBrand: boolean;
}

export interface ParsedSearchPage {
	results: SearchResult[];
	blocked: boolean;
	droppedSponsored: number;
	droppedDuplicate: number;
	/** 标题对不上品牌的条数；持续偏高说明 p_89 过滤没生效，要去看页面。 */
	brandMismatches: number;
}

export function buildSearchUrl(brand: string, page = 1): string {
	const q = encodeURIComponent(brand);
	const base = `https://www.amazon.com/s?k=${q}&rh=p_89%3A${q}&s=date-desc-rank`;
	return page > 1 ? `${base}&page=${page}` : base;
}

/**
 * 在页面里执行的脚本。
 *
 * ⚠️ 只能取 `div.s-main-slot > div[data-component-type="s-search-result"]`。
 * 实测整页有 58 个带 data-asin 的元素，其中只有 48 个是真结果，另外 10 个是
 * 「相关推荐」轮播 —— 混进来会把别家品牌的商品误报成本品牌上新。
 */
export const SEARCH_PAGE_SCRIPT = `(() => {
  const tiles = [...document.querySelectorAll(
    'div.s-main-slot > div[data-component-type="s-search-result"][data-asin]')]
    .filter(t => (t.getAttribute('data-asin') || '').length === 10)
    .map(t => ({
      asin: t.getAttribute('data-asin'),
      title: (t.querySelector('h2')?.innerText || '').trim(),
      sponsored: /\\bSponsored\\b/i.test(t.innerText || ''),
    }));
  const html = document.documentElement.innerHTML;
  return {
    tiles,
    blocked: html.includes('validateCaptcha') ||
             (document.body.innerText.includes('Continue shopping') && tiles.length === 0),
    title: document.title.slice(0, 80),
  };
})()`;

function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/**
 * 过滤、去重、做品牌观测。
 *
 * **品牌对不上的不丢弃**，只计数。原因有两个：`p_89` 已经是硬过滤（实测
 * 48/48 准确），而 Amazon 会按会话返回本地化标题（实测出现过
 * 「NOW Foods 诺奥 食品补充剂…」），拿标题当硬校验会误杀真实结果。
 */
export function parseSearchPage(
	raw: RawSearchPage,
	brand: string,
	seenInThisRun: Set<string> = new Set(),
): ParsedSearchPage {
	const brandKey = normalize(brand);
	const results: SearchResult[] = [];
	let droppedSponsored = 0;
	let droppedDuplicate = 0;
	let brandMismatches = 0;

	for (const tile of raw.tiles ?? []) {
		if (!tile?.asin || tile.asin.length !== 10) continue;
		// 广告位是花钱买的曝光，不代表品牌目录
		if (tile.sponsored) {
			droppedSponsored += 1;
			continue;
		}
		if (seenInThisRun.has(tile.asin)) {
			droppedDuplicate += 1;
			continue;
		}
		seenInThisRun.add(tile.asin);

		const titleMatchesBrand = normalize(tile.title ?? "").includes(brandKey);
		if (!titleMatchesBrand) brandMismatches += 1;

		results.push({
			asin: tile.asin,
			title: (tile.title ?? "").slice(0, 500),
			titleMatchesBrand,
		});
	}

	return {
		results,
		blocked: Boolean(raw.blocked),
		droppedSponsored,
		droppedDuplicate,
		brandMismatches,
	};
}

/**
 * 上一轮为什么停 —— 决定这一轮要浅扫还是深扫。
 *
 * `page_cap` / `failed` 意味着**上次没扫到底**，那一页之后的商品从没被记录过；
 * 若这轮仍按「见过就停」来判，它们永远补不回来。
 */
export type ScanStopReason = "caught_up" | "exhausted" | "page_cap" | "failed";

/** 只有确定上次扫到底了，这轮才敢浅扫。没记录 = 当作没扫完。 */
export function needsDeepScan(previous: ScanStopReason | null): boolean {
	return previous !== "caught_up" && previous !== "exhausted";
}

/**
 * 连续见过多少条才认为「追上历史」。
 *
 * 只要一条就停的话，排序抖动（老商品偶然排到新商品前面）会导致误停，把它
 * 后面还没见过的新品一起漏掉。要求连续 k 条，代价几乎为零。
 */
export const CAUGHT_UP_STREAK = 3;

/**
 * 该不该继续翻下一页。
 *
 * 按最新排序时新品必然在最前面，所以稳态下第 1 页就够。终止条件不依赖
 * 「共 N 条」那个数字 —— 它是模糊估算，同一 URL 实测见过 1,000 / 2,000 / 10,000。
 *
 * **deepScan 时无视「追上历史」，一路翻到上限** —— 上次没扫到底的品牌，
 * 必须真的翻过去才能把漏的补上。
 */
export function shouldFetchNextPage(input: {
	page: number;
	results: SearchResult[];
	newAsins: number;
	/** 这一页末尾连续见过的条数；用来抵抗排序抖动 */
	trailingSeenStreak?: number;
	deepScan?: boolean;
}): boolean {
	if (input.page >= MAX_SEARCH_PAGES) return false;
	if (input.results.length === 0) return false;
	if (input.deepScan) return true;
	// 追上历史的判据：末尾连续出现足够多的「见过」
	const streak =
		input.trailingSeenStreak ?? input.results.length - input.newAsins;
	return streak < CAUGHT_UP_STREAK;
}

/**
 * 商品页里抠变体家族用的在页脚本。
 *
 * 只返回**包含两个标记的那一小段**，不是整页 —— 商品页有 2.4MB，整页经
 * CDP 传回来纯属浪费。真正的解析交给 extractVariationFamily（纯函数、有测试）。
 */
export const VARIATION_PAGE_SCRIPT = `(() => {
  const html = document.documentElement.innerHTML;
  const start = html.indexOf('"parentAsin"');
  const dvd = html.indexOf('"dimensionValuesDisplayData"');
  const from = Math.min(...[start, dvd].filter(i => i >= 0).concat([html.length]));
  return {
    // 两个标记通常紧挨着；给足 20KB 兜住变体多的商品
    fragment: from < html.length ? html.slice(from, from + 20000) : "",
    // 真商品页必有 productTitle；被拦的页面没有，不能拿来下结论
    readable: !!document.getElementById('productTitle'),
    title: document.title.slice(0, 80),
    // 上新发现的商品也留档，理由同下架检查那条
    fullHtml: document.getElementById('productTitle') ? html : '',
    // 商品详情区（含 Date First Available）。只回传这一段，不是整页。
    detailFragment: (() => {
      const el = document.getElementById('detailBullets_feature_div')
        || document.getElementById('productDetails_detailBullets_sections1')
        || document.getElementById('prodDetails')
        || document.getElementById('detailBulletsWrapper_feature_div');
      return el ? el.innerText.slice(0, 4000) : '';
    })(),
  };
})()`;

export interface RawVariationPage {
	fragment: string;
	readable: boolean;
	title: string;
	fullHtml: string;
	/** 商品详情区文本，用来抠 Date First Available */
	detailFragment: string;
}

/**
 * 下架检查用的在页脚本：只回传判定需要的几个标记 + byline 片段。
 *
 * 不回传整页 —— 商品页 2.4MB，几千条经 CDP 传回来纯属浪费。判定规则本身在
 * `classifyProductMarkers`（fetch 和浏览器两条通道共用同一份）。
 */
export const PRODUCT_PAGE_SCRIPT = `(() => {
  const html = document.documentElement.innerHTML;
  const text = document.body ? document.body.innerText : '';
  // ⚠️ 直接取元素的 outerHTML，别在 HTML 字符串里找位置再切窗口。
  // 踩过：indexOf('id="bylineInfo"') 会先命中容器 id="bylineInfo_feature_div"，
  // 真正的 <a id="bylineInfo"> 在它后面几百字符，落在窗口外 —— 结果 4,423 条
  // 跑完只抠到 35% 的品牌，而存档实测有 95% 的页面是有这个锚点的。
  const bylineEl = document.getElementById('bylineInfo');
  return {
    markers: {
      hasCaptcha: html.includes('/errors/validateCaptcha') ||
                  text.includes('Enter the characters you see below'),
      hasDogPage: text.includes('Dogs of Amazon') ||
                  text.includes("couldn't find that page") ||
                  text.includes('couldn\\u2019t find that page'),
      hasProductTitle: !!document.getElementById('productTitle'),
      hasContinueShopping: text.includes('Continue shopping'),
    },
    // 品牌名就在这个元素里，顺手带回来，零额外请求
    bylineFragment: bylineEl ? bylineEl.outerHTML : '',
    // 整页留档用。实测 1.79MB 经 CDP 传回只要 109ms，相比每页 ~7 秒可忽略。
    // 只在真商品页上带回来 —— 拦截页和 dog page 存了没意义还会污染以后的解析。
    fullHtml: document.getElementById('productTitle') ? html : '',
  };
})()`;

export interface RawProductPage {
	markers: {
		hasCaptcha: boolean;
		hasDogPage: boolean;
		hasProductTitle: boolean;
		hasContinueShopping: boolean;
	};
	bylineFragment: string;
	/** 整页 HTML，仅真商品页才有；供本地留档 */
	fullHtml: string;
}
