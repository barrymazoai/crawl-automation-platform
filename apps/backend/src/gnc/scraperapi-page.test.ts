import { describe, expect, it } from "vitest";
import { createScraperApiPage } from "./scraperapi-page.js";
import { GNC_DISCOVERY_SCRIPT } from "./capture.js";

/** navigate 把 <5000 字符的 200 响应当空页处理，测试页面补足长度。 */
const PAD = `<!-- ${"x".repeat(6000)} -->`;

function pageFor(html: string) {
  return createScraperApiPage({
    apiKey: "test",
    fetchImpl: (async () => new Response(html + PAD, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch,
  });
}

describe("ScraperApiPage innerText", () => {
  it("不把 <script>/<style> 里的文本算进正文，脚本里的 captcha 字样不会触发 denied 误判", async () => {
    const page = pageFor(`<html><head><style>.x{content:"captcha"}</style></head><body>
      <script>var u="https://www.gnc.com/on/demandware.store/Sites-GNC2-Site/default/RateLimiter-HideCaptcha";</script>
      <h1>Bucked Up</h1><a href="https://www.gnc.com/pre-workout-supplements/500954.html">Woke AF</a>
      </body></html>`);
    await page.navigate("https://www.gnc.com/brands/bucked-up/");
    const text = await page.evaluate<string>("document.body.innerText");
    expect(text).toContain("Bucked Up");
    expect(text).not.toContain("captcha");
    const discovery = await page.evaluate<{ denied: boolean; productLinks: string[] }>(GNC_DISCOVERY_SCRIPT);
    expect(discovery.denied).toBe(false);
    expect(discovery.productLinks).toEqual(["https://www.gnc.com/pre-workout-supplements/500954.html"]);
  });

  it("真正的拦截页仍然判 denied", async () => {
    const page = pageFor(`<html><body><h1>Access to this page has been denied</h1><p>Press & Hold</p></body></html>`);
    // navigate 阶段就识别为拦截页，不建文档、不重试（maxRetries 默认 0）
    await page.navigate("https://www.gnc.com/brands/x/");
    expect(page.requestCount).toBe(1);
    await expect(page.evaluate(GNC_DISCOVERY_SCRIPT)).rejects.toThrow(/尚未成功 navigate/);
  });
});

describe("GNC 目录页发现（ScraperAPI/linkedom）", () => {
  it("同时收 6 位数字 SKU 链接和商品卡片里的母产品链接，不收搜索链接", async () => {
    const page = pageFor(`<html><body><span>5 Results</span>
      <div class="product-tile"><div class="pdp-link"><a href="/energy-drinks/alaniNuEnergyCase.html">Energy Drink</a></div><a href="/search?q=ghost">ghost</a></div>
      <div class="product-tile"><div class="pdp-link"><a href="/pre-workout-supplements/561567.html">Pre-Workout+</a></div></div>
      <div class="product-tile"><div class="image-container"><a href="/protein-bars/alaniNuProteinBar.html"><img></a></div></div>
      <a href="/brands/">All brands</a>
      </body></html>`);
    await page.navigate("https://www.gnc.com/brands/alani-nu/");
    const discovery = await page.evaluate<{ productLinks: string[]; expectedCount: number | null }>(GNC_DISCOVERY_SCRIPT);
    expect(discovery.expectedCount).toBe(5);
    expect(discovery.productLinks.map((u) => new URL(u, "https://www.gnc.com/").pathname).sort()).toEqual([
      "/energy-drinks/alaniNuEnergyCase.html", "/pre-workout-supplements/561567.html", "/protein-bars/alaniNuProteinBar.html",
    ]);
  });
});
