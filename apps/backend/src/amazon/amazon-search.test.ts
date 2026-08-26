import { describe, expect, it } from "vitest";
import {
	buildSearchUrl,
	CAUGHT_UP_STREAK,
	MAX_SEARCH_PAGES,
	needsDeepScan,
	parseSearchPage,
	type RawSearchPage,
	shouldFetchNextPage,
} from "./amazon-search";

function raw(tiles: RawSearchPage["tiles"], blocked = false): RawSearchPage {
	return { tiles, blocked, title: "Amazon.com : NOW Foods" };
}

describe("buildSearchUrl", () => {
	it("builds the newest-arrivals url with the brand filter", () => {
		expect(buildSearchUrl("NOW Foods")).toBe(
			"https://www.amazon.com/s?k=NOW%20Foods&rh=p_89%3ANOW%20Foods&s=date-desc-rank",
		);
	});

	it("appends the page param only past page 1", () => {
		expect(buildSearchUrl("NOW Foods", 1)).not.toContain("page=");
		expect(buildSearchUrl("NOW Foods", 3)).toContain("&page=3");
	});

	it("escapes brands with punctuation", () => {
		expect(buildSearchUrl("Bell & Co")).toContain("Bell%20%26%20Co");
	});
});
describe("parseSearchPage", () => {
	it("keeps organic results", () => {
		const page = parseSearchPage(
			raw([
				{ asin: "B0HBNVF4C3", title: "NOW Foods Calcium", sponsored: false },
				{ asin: "B0HBNZJ2MR", title: "NOW Foods Niacin", sponsored: false },
			]),
			"NOW Foods",
		);
		expect(page.results.map((r) => r.asin)).toEqual([
			"B0HBNVF4C3",
			"B0HBNZJ2MR",
		]);
	});

	it("drops sponsored tiles — paid placement is not the brand catalogue", () => {
		const page = parseSearchPage(
			raw([
				{ asin: "B0HBNVF4C3", title: "NOW Foods Calcium", sponsored: true },
				{ asin: "B0HBNZJ2MR", title: "NOW Foods Niacin", sponsored: false },
			]),
			"NOW Foods",
		);
		expect(page.results).toHaveLength(1);
		expect(page.droppedSponsored).toBe(1);
	});

	it("dedupes across pages via the shared seen set", () => {
		const seen = new Set<string>();
		const first = parseSearchPage(
			raw([{ asin: "B0HBNVF4C3", title: "NOW Foods A", sponsored: false }]),
			"NOW Foods",
			seen,
		);
		const second = parseSearchPage(
			raw([
				{ asin: "B0HBNVF4C3", title: "NOW Foods A", sponsored: false },
				{ asin: "B0HBNZJ2MR", title: "NOW Foods B", sponsored: false },
			]),
			"NOW Foods",
			seen,
		);
		expect(first.results).toHaveLength(1);
		expect(second.results.map((r) => r.asin)).toEqual(["B0HBNZJ2MR"]);
		expect(second.droppedDuplicate).toBe(1);
	});

	it("ignores malformed asins", () => {
		const page = parseSearchPage(
			raw([
				{ asin: "TOOSHORT", title: "x", sponsored: false },
				{ asin: "B0HBNVF4C3", title: "NOW Foods A", sponsored: false },
			]),
			"NOW Foods",
		);
		expect(page.results).toHaveLength(1);
	});

	it("flags but does NOT drop localized titles that omit the brand", () => {
		// 实测 Amazon 会按会话返回中文标题；拿标题当硬校验会误杀真实结果，
		// 而 p_89 已经是硬过滤（实测 48/48 准确）
		const page = parseSearchPage(
			raw([
				{
					asin: "B0HBNVF4C3",
					title: "诺奥 食品补充剂 维生素",
					sponsored: false,
				},
			]),
			"NOW Foods",
		);
		expect(page.results).toHaveLength(1);
		expect(page.results[0]?.titleMatchesBrand).toBe(false);
		expect(page.brandMismatches).toBe(1);
	});

	it("matches the brand regardless of case and punctuation", () => {
		const page = parseSearchPage(
			raw([
				{
					asin: "B0HBNVF4C3",
					title: "now foods supplements, calcium",
					sponsored: false,
				},
			]),
			"NOW Foods",
		);
		expect(page.results[0]?.titleMatchesBrand).toBe(true);
		expect(page.brandMismatches).toBe(0);
	});

	it("surfaces the blocked flag so an empty page is not read as `no products`", () => {
		const page = parseSearchPage(raw([], true), "NOW Foods");
		expect(page.blocked).toBe(true);
		expect(page.results).toHaveLength(0);
	});

	it("tolerates a missing tiles array", () => {
		const page = parseSearchPage(
			{ tiles: undefined as never, blocked: false, title: "" },
			"NOW Foods",
		);
		expect(page.results).toHaveLength(0);
	});
});

describe("shouldFetchNextPage — 自适应翻页", () => {
	const results = Array.from({ length: 48 }, (_, i) => ({
		asin: `B0000000${String(i).padStart(2, "0")}`,
		title: "x",
		titleMatchesBrand: true,
	}));

	it("does NOT stop on a single stale item — sort jitter would cause misses", () => {
		// 老商品偶然排到新商品前面时，只凭一条就停会把后面的新品一起漏掉
		expect(shouldFetchNextPage({ page: 1, results, newAsins: 47 })).toBe(true);
	});

	it("stops once enough trailing items are all already seen", () => {
		// 末尾连续 CAUGHT_UP_STREAK 条见过 = 真的追上历史了
		expect(
			shouldFetchNextPage({
				page: 1,
				results,
				newAsins: 45,
				trailingSeenStreak: CAUGHT_UP_STREAK,
			}),
		).toBe(false);
	});

	it("deep scan ignores the catch-up rule — it must actually reach the pages it missed", () => {
		// 上次触上限 / 失败的品牌，不深扫的话漏掉的页永远补不回来
		expect(
			shouldFetchNextPage({
				page: 1,
				results,
				newAsins: 0,
				trailingSeenStreak: 48,
				deepScan: true,
			}),
		).toBe(true);
	});

	it("keeps going when the whole page is new (a burst of listings)", () => {
		expect(shouldFetchNextPage({ page: 1, results, newAsins: 48 })).toBe(true);
	});

	it("never goes past Amazon's hard 7-page cap", () => {
		expect(
			shouldFetchNextPage({ page: MAX_SEARCH_PAGES, results, newAsins: 48 }),
		).toBe(false);
	});

	it("stops on an empty page", () => {
		expect(shouldFetchNextPage({ page: 1, results: [], newAsins: 0 })).toBe(
			false,
		);
	});
});

describe("needsDeepScan", () => {
	it("requires a deep scan when last time did not reach the end", () => {
		// 这两种情况说明「历史本身不完整」，浅扫会让漏掉的页永远补不回来
		expect(needsDeepScan("page_cap")).toBe(true);
		expect(needsDeepScan("failed")).toBe(true);
		expect(needsDeepScan(null)).toBe(true); // 从没扫过
	});

	it("allows a shallow scan only when last time genuinely finished", () => {
		expect(needsDeepScan("caught_up")).toBe(false);
		expect(needsDeepScan("exhausted")).toBe(false);
	});
});
