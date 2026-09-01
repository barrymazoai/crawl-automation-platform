/**
 * Swanson 的取数通道：固定走浏览器。
 *
 * 一开始是纯 HTTP 的——商品数据本来就在 Shopify 的 .js 与 Constructor 的 JSON 里，
 * 看着不需要浏览器。但实测下来 HTTP 这条路要自己处理一堆事：商品页带 302 重定向、
 * 要正确的 UA 才不被打回、成分表所在的页面有 950KB、而且 43 个商品就把 Cloudflare
 * 的速率限制触发了（HTTP 429）。这些浏览器天然都对。
 *
 * 更关键的是成分表：它在页面内嵌的 JSON 里，页面渲染本来就要下那 950KB，
 * 就地抠出来只回传几 KB，比把整页经 CDP 传回 Node 划算得多。
 *
 * 所以不再区分通道——目录接口、商品 JSON、成分表全部在浏览器里取。
 */
import { createPageHolder } from "../amazon/browser.js";

/** 被限流/拦截的信号：意味着"慢点"或"不欢迎"，而不是"这个地址不存在"。 */
export const BLOCK_STATUSES = new Set([403, 429, 503]);

export class SwansonBlockedError extends Error {
  constructor(public status: number, url: string) {
    super(`Swanson 请求被拦截 HTTP ${status}：${url}`);
    this.name = "SwansonBlockedError";
  }
}

/** 还原 JSON 字符串字面量里的转义。 */
export function decodeFactsValue(value: string) {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, "/").replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, " ").replace(/\\\\/g, "\\")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim();
}

export interface SwansonFetcher {
  /** 取任意 JSON/文本接口（目录、商品 .js），在页面上下文里发请求。 */
  text(url: string, signal: AbortSignal): Promise<string>;
  /** 打开商品页并就地抠出成分表；抠不到返回 null，由图片线兜底。 */
  facts(url: string, signal: AbortSignal): Promise<string | null>;
  close(): Promise<void>;
}

/** 在页面里按字段名扫描内嵌 JSON。手写扫描而非正则：值里含转义引号会把正则截断。 */
const FACTS_SCRIPT = String.raw`(() => {
  const html = document.documentElement.innerHTML;
  const read = (field) => {
    const m = new RegExp('["\']?' + field + '["\']?\\s*:\\s*"', 'i').exec(html);
    if (!m) return null;
    let i = m.index + m[0].length, out = '';
    while (i < html.length) {
      const ch = html[i];
      if (ch === '\\') { out += ch + (html[i + 1] || ''); i += 2; continue; }
      if (ch === '"') break;
      out += ch; i += 1;
    }
    return out.length >= 20 ? out : null;
  };
  for (const field of ['supplementFacts', 'nutritionFacts', 'productFacts', 'drugFacts']) {
    const value = read(field);
    if (value) return { field: field, raw: value, other: read('otherIngredients') || read('ingredients') };
  }
  return null;
})()`;

export function createSwansonFetcher(origin = "https://www.swansonvitamins.com"): SwansonFetcher {
  const holder = createPageHolder();
  let landed = false;

  /** 目录与商品 JSON 走页面内 fetch：同源 Cookie 与 TLS 指纹都是真实浏览器的。 */
  const ensureLanded = async (browser: { navigate(url: string): Promise<number> }) => {
    if (landed) return;
    await browser.navigate(origin);
    landed = true;
  };

  return {
    async text(url) {
      return holder.run(async (browser) => {
        await ensureLanded(browser);
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

    async facts(url) {
      return holder.run(async (browser) => {
        const status = await browser.navigate(url);
        if (status >= 400) {
          if (BLOCK_STATUSES.has(status)) throw new SwansonBlockedError(status, url);
          throw new Error(`Swanson HTTP ${status}: ${url}`);
        }
        landed = true;
        const found = await browser.evaluate<{ field: string; raw: string; other: string | null } | null>(FACTS_SCRIPT);
        if (!found) return null;
        const text = decodeFactsValue(found.raw);
        const other = found.other ? decodeFactsValue(found.other) : null;
        return other && !text.includes(other.slice(0, 40)) ? `${text}\n${other}` : text;
      });
    },

    async close() { await holder.close(); },
  };
}
