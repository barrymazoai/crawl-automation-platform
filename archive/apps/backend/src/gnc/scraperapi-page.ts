/**
 * ScraperAPI 版取数层：与浏览器 Page 同接口（navigate/evaluate），但内部走
 * ScraperAPI 拉 HTML、用 linkedom 建内存 DOM，再在 DOM 上跑同一套提取脚本。
 *
 * 为什么这么做：GNC 的 PerimeterX 把自建代理这条路彻底堵死（今日实测：干净住宅
 * IP 首访能过，但同 IP 一频繁就被降级，而代理 7 天只能换一次 IP，数学上跑不完）。
 * ScraperAPI 有海量住宅 IP 池 + 过 PX 能力，把这一层外包出去；我们只管解析。
 *
 * 关键在于复用：GNC 的 GNC_DISCOVERY_SCRIPT / GNC_PRODUCT_SCRIPT 是 DOM 脚本，
 * 让它们在 linkedom 的 document 上原样跑，提取逻辑一行不改，只把"内容从哪来"换掉。
 */
import { parseHTML } from "linkedom";
import type { Page, BrowserTraffic } from "../amazon/browser.js";

const EMPTY_TRAFFIC: BrowserTraffic = { requestCount: 0, failedRequestCount: 0, encodedBytes: 0, byResourceType: {} };

export interface ScraperApiOptions {
  apiKey: string;
  /** 让 ScraperAPI 执行页面 JS（拿懒加载/渲染后内容）。贵 10~25 倍额度，默认关。 */
  render?: boolean;
  /** 出口国家，GNC 要美国。 */
  countryCode?: string;
  /** 请求超时毫秒。ScraperAPI 过 PX 可能较慢，给足。 */
  timeoutMs?: number;
  /**
   * 对"已扣费"响应（200/404）绝不重试。只对 ScraperAPI 不收费的失败重试：
   * 5xx / 499 / 网络超时，最多 freeRetries 次（默认 2）。
   */
  freeRetries?: number;
  /** @deprecated 旧名，等同 freeRetries。 */
  maxRetries?: number;
  /** 免费重试的退避基数（毫秒），第 n 次等 n×基数。 */
  retryDelayMs?: number;
  /**
   * 收到 403（key 额度耗尽 / 并发超限）时换 key：返回新 key 则同一 URL 用新 key 再发一次（403 不扣费），
   * 返回 null 则放弃。由 worker 的 key 池提供。
   */
  onKeyExhausted?: (exhaustedKey: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  log?: (event: Record<string, unknown>) => void;
}

/** 被 PX 拦或空响应的信号——ScraperAPI 偶尔也会返回未过 PX 的页面，要能识别并重试。 */
function looksBlocked(html: string) {
  return /Access to this page has been denied|Pardon Our Interruption|Press & Hold/i.test(html)
    || /px-captcha|_pxCaptcha/i.test(html);
}

export function createScraperApiPage(options: ScraperApiOptions): Page & { requestCount: number } {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 90_000;
  // 已扣费的响应（200/404）一次定生死；只有不扣费的失败（5xx/499/超时）才重试，见 navigate 内注释。
  const freeRetries = options.freeRetries ?? options.maxRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  let apiKey = options.apiKey;

  let currentDocument: ReturnType<typeof parseHTML>["document"] | null = null;
  let currentWindow: any = null;
  let currentUrl = "about:blank";
  let requestCount = 0;

  const build = (url: string) => {
    const params = new URLSearchParams({ api_key: apiKey, url });
    if (options.countryCode) params.set("country_code", options.countryCode);
    if (options.render) params.set("render", "true");
    return `https://api.scraperapi.com/?${params.toString()}`;
  };

  const page: Page & { requestCount: number } = {
    get requestCount() { return requestCount; },

    async navigate(url: string): Promise<number> {
      currentUrl = url;
      let lastStatus = 0;
      let freeAttemptsLeft = freeRetries;
      let keySwitches = 0;
      while (true) {
        requestCount += 1;
        let retryFree = false;
        try {
          const response = await fetchImpl(build(url), { signal: AbortSignal.timeout(timeoutMs) });
          lastStatus = response.status;
          const html = await response.text();
          /*
           * ScraperAPI 只对 200/404 收费。分四类：
           * - 404/410：目标页确实不存在（已扣费，终态）。把文档建出来交给上层，discover 会看到没有商品链接、正常收尾。
           * - 200 且内容够长且没被 PX 拦：成功（已扣费）。
           * - 200 但被 PX 拦/内容异常：已扣费，重试也不会变好，一次定生死。
           * - 403：key 额度耗尽或并发超限（不扣费）→ 换 key 再发一次。
           * - 5xx / 499 / 超时：ScraperAPI 自身失败（不扣费）→ 最多再试 freeRetries 次。
           */
          if (response.status === 404 || response.status === 410) {
            const parsed = parseHTML(html);
            currentDocument = parsed.document;
            currentWindow = parsed.window ?? parsed;
            return response.status;
          }
          if (response.status === 200 && html.length > 5_000 && !looksBlocked(html)) {
            const parsed = parseHTML(html);
            currentDocument = parsed.document;
            currentWindow = parsed.window ?? parsed;
            return 200;
          }
          if (response.status === 403 && options.onKeyExhausted && keySwitches < 3) {
            const next = await options.onKeyExhausted(apiKey);
            options.log?.({ type: "scraperapi_key_switch", status: 403, switched: Boolean(next), url });
            if (next) { apiKey = next; keySwitches += 1; continue; }
          }
          retryFree = response.status >= 500 || response.status === 499 || response.status === 429;
          options.log?.({ type: "scraperapi_retry", status: response.status, len: html.length, blocked: looksBlocked(html), free: retryFree, left: freeAttemptsLeft, url });
        } catch (error) {
          retryFree = true;
          options.log?.({ type: "scraperapi_error", message: error instanceof Error ? error.message : String(error), left: freeAttemptsLeft, url });
        }
        if (!retryFree || freeAttemptsLeft <= 0) break;
        freeAttemptsLeft -= 1;
        await new Promise((r) => setTimeout(r, retryDelayMs * (freeRetries - freeAttemptsLeft)));
      }
      currentDocument = null;
      return lastStatus || 0;
    },

    async evaluate<T>(expression: string): Promise<T> {
      if (!currentDocument) throw new Error("ScraperApiPage: 尚未成功 navigate，没有可求值的文档");
      /*
       * 在 linkedom 的 document 上跑提取脚本。GNC 脚本用到 document / location /
       * window，这里把它们注入到脚本作用域；linkedom 不实现 innerText，用
       * textContent 兜一层（GNC 脚本对 innerText 的用法都是取纯文本，等价）。
       */
      const documentProxy = new Proxy(currentDocument as any, {
        get(target, prop) {
          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const location = new URL(currentUrl);
      const fn = new Function("document", "location", "window", "screen", "navigator", `return (${expression});`);
      const result = fn(
        patchInnerText(documentProxy),
        { href: location.href, pathname: location.pathname, search: location.search, origin: location.origin },
        currentWindow ?? {},
        { width: 1920, height: 1080 },
        { userAgent: "Mozilla/5.0", languages: ["en-US"] },
      );
      return result as T;
    },

    traffic(): BrowserTraffic {
      return { ...EMPTY_TRAFFIC, requestCount };
    },
  };
  return page;
}

/** innerText 不含这些元素的内容；textContent 含。GNC 页面 <script> 里有 "RateLimiter-HideCaptcha" 之类的 URL，
 *  若把脚本文本算进正文，denied 的 /captcha/i 判定会把每个正常页都当成 PerimeterX 挑战（2026-09-02 实测误判）。 */
const PATCHED = Symbol("innerTextPatched");
const INNER_TEXT_SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

export function visibleText(node: any): string {
  if (!node) return "";
  if (node.nodeType === 3) return String(node.data ?? node.textContent ?? "");
  if (node.nodeType === 1 && INNER_TEXT_SKIP.has(String(node.tagName).toUpperCase())) return "";
  let out = "";
  for (const child of node.childNodes ?? []) out += visibleText(child);
  return out;
}

/**
 * 补齐 linkedom 缺的 DOM API，让 GNC 脚本照跑：
 * - innerText：linkedom 元素没有，按浏览器语义（不含 script/style）从文本节点拼；
 * - document.images：linkedom 没有这个集合，用 querySelectorAll('img') 顶上，
 *   且返回真数组（脚本里 [...document.images] 要求可迭代）。
 */
function patchInnerText(doc: any) {
  // linkedom 的 Element 自带 innerText，但语义是 textContent（含脚本文本），必须覆盖，
  // 覆盖到 Element 基类原型上（body 的构造器是 HTMLBodyElement，只改它不够）。
  let proto = doc?.body ? Object.getPrototypeOf(doc.body) : null;
  while (proto && proto !== Object.prototype) {
    const own = Object.getOwnPropertyDescriptor(proto, "innerText");
    if (own && !(own.get as any)?.[PATCHED]) {
      try {
        const getter = function (this: any) { return visibleText(this); };
        (getter as any)[PATCHED] = true;
        Object.defineProperty(proto, "innerText", { get: getter, configurable: true });
      } catch { /* 不可定义就算了 */ }
    }
    proto = Object.getPrototypeOf(proto);
  }
  try {
    if (!Array.isArray(doc.images)) {
      Object.defineProperty(doc, "images", {
        get() { return [...this.querySelectorAll("img")]; }, configurable: true,
      });
    }
  } catch { /* 忽略 */ }
  return doc;
}

/**
 * 和 createPageHolder 同接口的 ScraperAPI holder，直接塞进 GNC capture。
 * 单个 page 复用（ScraperAPI 每次 navigate 都是独立请求，无标签页状态可污染），
 * 内部自带重试，所以 holder.run 不需要再包一层换标签页逻辑。
 */
export function createScraperApiHolder(options: ScraperApiOptions) {
  const page = createScraperApiPage(options);
  return {
    async run<T>(fn: (page: Page) => Promise<T>): Promise<T> { return fn(page); },
    async close() { /* 无资源可释放 */ },
    get requestCount() { return page.requestCount; },
  };
}
