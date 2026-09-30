/**
 * 产品链接下架检测 —— 零依赖纯函数。
 *
 * 两个调用方共用这一份判定规则：`packages/api` 的 link-check-run 任务，
 * 以及跑在 Mac mini 上的 `apps/link-monitor`。规则只能有一份，两处各存一份
 * 迟早跑偏。
 *
 * 基本版：单次 fetch + 状态码/页面标记分类。反爬（Amazon captcha/503）只会
 * 让结果落到 unknown，绝不误判为下架；后续升级动态 IP / 第三方抓取 API 时，
 * 只需替换 checkProductLink 的实现，分类器与调用方不变。
 */

export type CheckStatus = "active" | "unlisted" | "unknown";

export interface CheckResult {
	status: CheckStatus;
	reason: string;
}
/** Amazon 机器人验证页标记；该页可能伴随 200 或 503，必须先于状态码判断。 */
const CAPTCHA_MARKERS = [
	"/errors/validateCaptcha",
	"Enter the characters you see below",
];

/** Amazon dog page（死链页）标记；dog page 也可能以 200 返回。 */
const DOG_PAGE_MARKERS = [
	"Dogs of Amazon",
	"couldn't find that page",
	"couldn’t find that page",
];

/**
 * 页面上那几个决定判定的标记。
 *
 * 抽出来是为了让**浏览器通道**也能用同一套规则：走 CDP 时拿到的是 DOM，
 * 把整页 2.4MB 传回来再跑正则纯属浪费，在页里算好这几个布尔值即可。
 */
export interface PageMarkers {
	hasCaptcha: boolean;
	hasDogPage: boolean;
	hasProductTitle: boolean;
	hasContinueShopping: boolean;
}

export function markersFromHtml(html: string): PageMarkers {
	return {
		hasCaptcha: CAPTCHA_MARKERS.some((m) => html.includes(m)),
		hasDogPage: DOG_PAGE_MARKERS.some((m) => html.includes(m)),
		hasProductTitle: html.includes("productTitle"),
		hasContinueShopping: html.includes("Continue shopping"),
	};
}

/** 判定规则的唯一实现；fetch 和浏览器两条通道都走这里。 */
export function classifyProductMarkers(input: {
	httpStatus: number;
	markers: PageMarkers;
}): CheckResult {
	const { httpStatus, markers } = input;

	// 先判反爬再判下架：把 captcha 拦截误报成「下架」比漏报严重得多。
	if (markers.hasCaptcha) {
		return { status: "unknown", reason: "captcha_blocked" };
	}

	// Amazon 的软拦截页：200 + 「Continue shopping」按钮、无 captcha 表单。
	// 实测（2026-08-10）编造 ASIN 拿到的就是这种页 —— 不识别它会把拦截误判成
	// active，假 active 会掩盖真下架。
	// 复合条件：真商品页必有 productTitle，带着它就绝不会走进这个分支。
	if (markers.hasContinueShopping && !markers.hasProductTitle) {
		return { status: "unknown", reason: "bot_interstitial" };
	}
	if (httpStatus === 503 || httpStatus === 429) {
		return { status: "unknown", reason: `http_${httpStatus}` };
	}

	// 404/410 同时是非 Amazon 链接的通用下架兜底。
	if (httpStatus === 404 || httpStatus === 410) {
		return { status: "unlisted", reason: `http_${httpStatus}` };
	}
	if (httpStatus >= 400) {
		return { status: "unknown", reason: `http_${httpStatus}` };
	}

	if (markers.hasDogPage) {
		return { status: "unlisted", reason: "dog_page" };
	}

	return { status: "active", reason: "ok" };
}

export function classifyProductPage(input: {
	httpStatus: number;
	html: string;
}): CheckResult {
	return classifyProductMarkers({
		httpStatus: input.httpStatus,
		markers: markersFromHtml(input.html),
	});
}

const BROWSER_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
};

export const CHECK_TIMEOUT_MS = 15_000;

export async function checkProductLink(
	url: string,
	fetchImpl: typeof fetch = fetch,
): Promise<CheckResult> {
	try {
		const res = await fetchImpl(url, {
			headers: BROWSER_HEADERS,
			redirect: "follow",
			signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
		});
		const html = await res.text();
		return classifyProductPage({ httpStatus: res.status, html });
	} catch (err) {
		const isTimeout = err instanceof Error && err.name === "TimeoutError";
		return {
			status: "unknown",
			reason: isTimeout ? "timeout" : "network_error",
		};
	}
}

/** 商品页 byline 里的品牌信息。 */
export interface BrandInfo {
	/** Amazon 自己认定的品牌名，如 "NOW Foods"。 */
	name: string;
	/** 品牌旗舰店链接（相对路径），没有则为 null。 */
	storeUrl: string | null;
	/** 店铺页的 GUID，没有则为 null。 */
	storeGuid: string | null;
}

/** `<a id="bylineInfo" href="…">Visit the X Store</a>`，属性顺序不固定。 */
const BYLINE_TAG_RE = /<a\b([^>]*\bid=["']bylineInfo["'][^>]*)>([\s\S]{0,300}?)<\/a>/i;
const HREF_RE = /\bhref=["']([^"']+)["']/i;
const STORE_GUID_RE = /\/page\/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/i;

/**
 * 从商品页 HTML 里抠品牌名和店铺链接。
 *
 * 为什么需要它：我们库里的公司名拿去做 Amazon 的品牌过滤是搜不到东西的
 * （实测 `MRO MaryRuth, LLC` 返回 0 条），必须用 Amazon 自己认定的品牌名，
 * 而这个名字就在商品页的 byline 上。
 *
 * 纯函数、不发请求 —— 调用方本来就抓了这个页面做下架判定，顺手抠一下而已。
 */
export function extractBrand(html: string): BrandInfo | null {
	const tag = html.match(BYLINE_TAG_RE);
	if (!tag) return null;

	const [, attrs = "", rawText = ""] = tag;
	const text = rawText
		.replace(/<[^>]*>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();

	// "Visit the NOW Foods Store" / "Brand: NOW Foods" / 裸品牌名
	const name = text
		.replace(/^Visit\s+the\s+/i, "")
		.replace(/\s+Store$/i, "")
		.replace(/^Brand:\s*/i, "")
		.trim();
	if (!name) return null;

	const href = attrs.match(HREF_RE)?.[1] ?? null;
	// byline 也可能指向搜索页而非旗舰店；只有 /stores/ 才算店铺链接。
	const storeUrl = href?.includes("/stores/") ? href : null;
	const storeGuid = storeUrl?.match(STORE_GUID_RE)?.[1]?.toUpperCase() ?? null;

	return { name, storeUrl, storeGuid };
}

/**
 * 与 checkProductLink 相同的判定，但**把 HTML 一并返回**，供调用方顺手做
 * byline 提取之类的二次利用。
 *
 * 单独开一个函数而不是改 checkProductLink 的返回值，是因为
 * `packages/api` 的 link-check-run 任务还在用后者，不该被这个需求牵动。
 */
export async function checkProductLinkWithHtml(
	url: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ result: CheckResult; html: string | null }> {
	try {
		const res = await fetchImpl(url, {
			headers: BROWSER_HEADERS,
			redirect: "follow",
			signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
		});
		const html = await res.text();
		return { result: classifyProductPage({ httpStatus: res.status, html }), html };
	} catch (err) {
		const isTimeout = err instanceof Error && err.name === "TimeoutError";
		return {
			result: {
				status: "unknown",
				reason: isTimeout ? "timeout" : "network_error",
			},
			html: null,
		};
	}
}

/** 一个变体家族：同一个 parentAsin 下的全部规格。 */
export interface VariationFamily {
	parentAsin: string | null;
	/** 家族成员；只有一个成员时说明这个商品没有变体。 */
	members: { asin: string; label: string }[];
}

const PARENT_ASIN_RE = /"parentAsin"\s*:\s*"([A-Z0-9]{10})"/;
const DVD_RE = /"dimensionValuesDisplayData"\s*:\s*(\{.*?\})\s*,\s*"/s;

/**
 * 从商品页 HTML 里抠变体家族。
 *
 * 页面里长这样（实测 B00028LZ9A）：
 *   "parentAsin":"B0BNGT5L9D"
 *   "dimensionValuesDisplayData":{
 *     "B00028LZ9A":["250 Count (Pack of 1)"],
 *     "B00028LZ90":["100 Count (Pack of 1)"],
 *     "B0GHCMTJWT":["250 Count (Pack of 2)"]}
 *
 * 用途：判断新发现的 ASIN 是**真新品**还是**已有产品的另一个规格**。
 * 抓一个成员的页面就能拿到整个家族，所以家族越大越省请求。
 */
export function extractVariationFamily(html: string): VariationFamily {
	const parentAsin = html.match(PARENT_ASIN_RE)?.[1] ?? null;

	const members: { asin: string; label: string }[] = [];
	const dvd = html.match(DVD_RE)?.[1];
	if (dvd) {
		// 逐个键值对地抠，避免整块 JSON.parse 因为相邻字段的转义而失败
		const entry = /"([A-Z0-9]{10})"\s*:\s*\[\s*"((?:[^"\\]|\\.)*)"/g;
		let m: RegExpExecArray | null = entry.exec(dvd);
		while (m !== null) {
			if (m[1]) {
				members.push({
					asin: m[1],
					label: (m[2] ?? "").replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
				});
			}
			m = entry.exec(dvd);
		}
	}

	return { parentAsin, members };
}

/**
 * 新发现的 ASIN 该算什么。
 *
 * 家族里只要有**任何一个**成员在我们产品库里，这一整族就都是「已有产品的
 * 变体」—— 因为它们本来就是同一个商品的不同规格。一个都没有才是候选新品。
 *
 * 拿不到家族信息（页面被拦、或商品无变体且没有 parentAsin）时返回
 * "unresolved"，不猜 —— 猜错会把变体报成新品，那正是要避免的噪音。
 */
export function classifyDiscovery(input: {
	asin: string;
	family: VariationFamily;
	knownAsins: ReadonlySet<string>;
	/**
	 * 商品页是否真的读到了。**必须区分**「页面被拦」和「这个商品本来就没有
	 * 变体」—— 两者都给出空家族，但前者该重试、后者已经有结论了。混为一谈
	 * 会让无变体的商品永远停在 unresolved、每轮重复抓。
	 */
	pageReadable: boolean;
}): "new_product" | "variant_of_known" | "unresolved" {
	const { asin, family, knownAsins, pageReadable } = input;
	if (knownAsins.has(asin)) return "variant_of_known";
	if (!pageReadable) return "unresolved";

	const memberAsins = family.members.map((m) => m.asin);
	if (memberAsins.some((a) => knownAsins.has(a))) return "variant_of_known";
	// 页面读到了但没有变体家族 = 独立商品，我们库里没有 → 就是新品
	return "new_product";
}

/** 商品详情区里几个值得顺手抠的字段。 */
export interface ProductDetails {
	/**
	 * Amazon 自己记录的首次上架日期（ISO `YYYY-MM-DD`）。
	 *
	 * **这是区分「真上新」和「我们刚入库」的唯一可靠依据。** 没有它的话，
	 * 一个 1999 年上架的商品被我们今天第一次扫到也会算成新品 ——
	 * 实测存档里就有 January 1, 1999 的货。
	 */
	dateFirstAvailable: string | null;
	/** 大类销量排名，判断卖得好不好 */
	bestSellersRank: number | null;
	/** 厂商，和 byline 品牌互相印证 */
	manufacturer: string | null;
}

const MONTHS: Record<string, string> = {
	january: "01", february: "02", march: "03", april: "04",
	may: "05", june: "06", july: "07", august: "08",
	september: "09", october: "10", november: "11", december: "12",
};

/** `September 13, 2007` → `2007-09-13`；认不出来返回 null，绝不猜。 */
export function parseAmazonDate(raw: string): string | null {
	const m = raw.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
	if (!m) return null;
	const month = MONTHS[(m[1] ?? "").toLowerCase()];
	if (!month) return null;
	return `${m[3]}-${month}-${String(m[2]).padStart(2, "0")}`;
}

/**
 * 从商品页 HTML 抠详情字段。
 *
 * 实测（2026-08-12，3,487 份存档）：99.9% 有 Product details 区块，
 * **97.6% 能抠到 Date First Available**。抠不到的 2.4% 里，一部分是书籍
 * （用 Publication date，这里一并兼容），其余是 Amazon 对个别老商品没填。
 *
 * 抠不到就返回 null —— **绝不能默认当成新品**，那 83 个抠不到的里有 1999 年、
 * 2007 年的老货，猜错等于把最该过滤的噪音放进上新清单。
 */
export function extractProductDetails(html: string): ProductDetails {
	// 书籍用 Publication date，普通商品用 Date First Available
	const dateRaw =
		html.match(/Date First Available[\s\S]{0,300}?([A-Z][a-z]+ \d{1,2},? \d{4})/)?.[1] ??
		html.match(/Publication date[\s\S]{0,300}?([A-Z][a-z]+ \d{1,2},? \d{4})/)?.[1] ??
		null;

	const rankRaw = html.match(/Best Sellers Rank[\s\S]{0,200}?#([\d,]+)\s+in/)?.[1];
	const manufacturer = html
		.match(/Manufacturer[\s\S]{0,200}?<span[^>]*>([^<]{1,80})<\/span>/)?.[1]
		?.replace(/&amp;/g, "&")
		.replace(/^[\s:‏‎]+/, "")
		.trim();

	return {
		dateFirstAvailable: dateRaw ? parseAmazonDate(dateRaw) : null,
		bestSellersRank: rankRaw ? Number(rankRaw.replace(/,/g, "")) : null,
		manufacturer: manufacturer || null,
	};
}
