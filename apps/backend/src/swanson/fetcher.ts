/**
 * Swanson 的取数通道，两条腿走路。
 *
 * 默认走纯 HTTP——Swanson 的商品数据本来就在 Shopify 的 .js 接口和 Constructor
 * 的 JSON 接口里，不需要浏览器，成本低一个量级。实测并发 10 无间隔也不限流。
 *
 * 但"小规模没限流"不等于"六千多个商品也没事"，可能有按分钟或按总量的配额。
 * 所以连续撞上限流信号时自动切到浏览器：**浏览器请求的是同样的 JSON 接口**，
 * 只是带上了真实的 TLS 指纹与 Cookie，解析逻辑一行都不用改。
 */
import { createPageHolder } from "../amazon/browser.js";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/** 被限流/拦截的信号：这些状态码意味着"慢点"或"不欢迎"，而不是"这个地址不存在"。 */
export const BLOCK_STATUSES = new Set([403, 429, 503]);

export class SwansonBlockedError extends Error {
  constructor(public status: number, url: string) {
    super(`Swanson 请求被拦截 HTTP ${status}：${url}`);
    this.name = "SwansonBlockedError";
  }
}

export interface SwansonFetcher {
  text(url: string, signal: AbortSignal): Promise<string>;
  /** 当前实际在用哪条通道，用于日志与遥测。 */
  readonly mode: "http" | "browser";
  close(): Promise<void>;
}

export interface FetcherOptions {
  /** 撞上限流后的重试次数（每次退避加倍）。 */
  maxRetries?: number;
  /** 退避基数毫秒。 */
  backoffMs?: number;
  /** 连续多少次被拦截后切换到浏览器。0 表示不切换。 */
  switchAfterBlocks?: number;
  log?: (event: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * 纯 HTTP 通道。429 带 Retry-After 时按它说的等，否则指数退避。
 * 404 之类的业务错误直接抛，不浪费退避预算。
 */
export function createHttpFetcher(options: FetcherOptions = {}): SwansonFetcher {
  const maxRetries = options.maxRetries ?? 3;
  const backoffMs = options.backoffMs ?? 2000;
  const sleep = options.sleep ?? wait;
  return {
    mode: "http",
    async text(url, signal) {
      for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal });
        if (response.ok) return response.text();
        if (!BLOCK_STATUSES.has(response.status)) throw new Error(`Swanson HTTP ${response.status}: ${url}`);
        if (attempt >= maxRetries) throw new SwansonBlockedError(response.status, url);
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs * 2 ** attempt;
        options.log?.({ type: "swanson_rate_limited", status: response.status, attempt: attempt + 1, delayMs: delay, url });
        await sleep(delay);
      }
    },
    async close() {},
  };
}

/**
 * 浏览器通道：在页面上下文里 fetch 同样的地址。
 * 先落到站点主页取得 Cookie 与同源上下文，之后的请求就是普通的同源请求。
 */
export function createBrowserFetcher(origin = "https://www.swansonvitamins.com"): SwansonFetcher {
  const holder = createPageHolder();
  let landed = false;
  return {
    mode: "browser",
    async text(url) {
      return holder.run(async (browser) => {
        if (!landed) { await browser.navigate(origin); landed = true; }
        const script = `fetch(${JSON.stringify(url)}, { credentials: 'include' })
          .then((r) => r.text().then((t) => ({ ok: r.ok, status: r.status, body: t })))`;
        const result = await browser.evaluate<{ ok: boolean; status: number; body: string }>(script);
        if (!result.ok) {
          if (BLOCK_STATUSES.has(result.status)) throw new SwansonBlockedError(result.status, url);
          throw new Error(`Swanson HTTP ${result.status}: ${url}`);
        }
        return result.body;
      });
    },
    async close() { await holder.close(); },
  };
}

/**
 * 会自己换腿的通道：默认 HTTP，连续被拦截到阈值就永久切到浏览器。
 *
 * 用"连续"而不是"累计"，是因为偶发的 503 是站点抖动，不该触发切换；
 * 连着好几次才说明是真被限流了。
 */
export function createResilientFetcher(options: FetcherOptions = {}): SwansonFetcher {
  const switchAfter = options.switchAfterBlocks ?? 2;
  const http = createHttpFetcher(options);
  let browser: SwansonFetcher | null = null;
  let consecutiveBlocks = 0;

  const self: SwansonFetcher = {
    get mode() { return browser ? "browser" : "http"; },
    async text(url, signal) {
      if (browser) return browser.text(url, signal);
      try {
        const body = await http.text(url, signal);
        consecutiveBlocks = 0;
        return body;
      } catch (error) {
        if (!(error instanceof SwansonBlockedError)) throw error;
        consecutiveBlocks += 1;
        if (switchAfter <= 0 || consecutiveBlocks < switchAfter) throw error;
        options.log?.({ type: "swanson_switch_to_browser", consecutiveBlocks, url });
        browser = createBrowserFetcher();
        return browser.text(url, signal);
      }
    },
    async close() { await http.close(); await browser?.close(); },
  };
  return self;
}
