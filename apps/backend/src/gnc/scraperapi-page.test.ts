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
      <div class="product-tile"><a class="thumb-link" href="/energy-drinks/alaniNuEnergyCase.html">Energy Drink</a><a href="/search?q=ghost">ghost</a>
        <a class="wishlist-product" href="https://www.gnc.com/on/demandware.store/Sites-GNC2-Site/default/Wishlist-Add">♡</a></div>
      <div class="product-tile"><a class="link" href="/pre-workout-supplements/561567.html">Pre-Workout+</a></div>
      <div class="product-tile"><a class="thumb-link" href="/protein-bars/alaniNuProteinBar.html"><img></a></div>
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

describe("ScraperAPI 请求的重试边界", () => {
  const ok = `<html><body><h1>ok</h1></body></html>${PAD}`;
  function sequence(statuses: number[], onKey?: (k: string) => void) {
    let i = 0; const keys: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      keys.push(new URL(String(input)).searchParams.get("api_key")!);
      const status = statuses[Math.min(i, statuses.length - 1)]!; i += 1;
      return new Response(status === 200 ? ok : "err", { status, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    return { fetchImpl, calls: () => i, keys };
  }

  it("5xx/499 不扣费，最多再试 2 次后成功", async () => {
    const f = sequence([500, 499, 200]);
    const page = createScraperApiPage({ apiKey: "k1", fetchImpl: f.fetchImpl, retryDelayMs: 0 });
    expect(await page.navigate("https://www.gnc.com/x/500001.html")).toBe(200);
    expect(f.calls()).toBe(3);
  });

  it("连续 5xx 超过 2 次就放弃，不无限重试", async () => {
    const f = sequence([500, 500, 500, 500, 500]);
    const page = createScraperApiPage({ apiKey: "k1", fetchImpl: f.fetchImpl, retryDelayMs: 0 });
    expect(await page.navigate("https://www.gnc.com/x/500001.html")).toBe(500);
    expect(f.calls()).toBe(3);
  });

  it("200 但被 PX 拦（已扣费）绝不重试", async () => {
    const blocked = `<html><body>Access to this page has been denied</body></html>${PAD}`;
    let calls = 0;
    const page = createScraperApiPage({ apiKey: "k1", fetchImpl: (async () => { calls += 1; return new Response(blocked, { status: 200 }); }) as typeof fetch });
    await page.navigate("https://www.gnc.com/x/500001.html");
    expect(calls).toBe(1);
  });

  it("403 换 key 后同一 URL 再发一次；没有可换的 key 就放弃", async () => {
    const f = sequence([403, 200]);
    const page = createScraperApiPage({ apiKey: "k1", fetchImpl: f.fetchImpl, onKeyExhausted: async () => "k2" });
    expect(await page.navigate("https://www.gnc.com/x/500001.html")).toBe(200);
    expect(f.keys).toEqual(["k1", "k2"]);

    const g = sequence([403, 403]);
    const page2 = createScraperApiPage({ apiKey: "k1", fetchImpl: g.fetchImpl, onKeyExhausted: async () => null });
    expect(await page2.navigate("https://www.gnc.com/x/500001.html")).toBe(403);
    expect(g.calls()).toBe(1);
  });
});
