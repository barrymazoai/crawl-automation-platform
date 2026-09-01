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
  /** 打开列表页并就地抠出 Constructor 接入参数，只回传这三个值。 */
  apiConfig(url: string, signal: AbortSignal): Promise<{ apiKey: string; filterName: string; filterValue: string } | null>;
  close(): Promise<void>;
}

/** 在页面里按字段名扫描内嵌 JSON。手写扫描而非正则：值里含转义引号会把正则截断。 */
const READ_FIELD_FN = String.raw`
  const read = (html, field) => {
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
`;

/** 同源 fetch 取源码后就地扫描，只回传抠到的几百字节。 */
function factsViaFetchScript(url: string) {
  return `fetch(${JSON.stringify(url)}, { credentials: 'include' }).then((r) => r.text()).then((html) => {
    ${READ_FIELD_FN}
    for (const field of ['supplementFacts', 'nutritionFacts', 'productFacts', 'drugFacts']) {
      const value = read(html, field);
      if (value) return { field: field, raw: value, other: read(html, 'otherIngredients') || read(html, 'ingredients') };
    }
    return null;
  })`;
}

/** 只比对 origin + pathname + 关键查询参数，忽略站点自己加的跟踪参数。 */
function sameTarget(actual: string, expected: string) {
  try {
    const a = new URL(actual), b = new URL(expected);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch { return false; }
}

/**
 * 在页面里抠 Constructor 接入参数。
 *
 * 跟成分表同一个道理：列表页有 1.1MB，把整页经 CDP 传回 Node 会把 Runtime.evaluate
 * 拖超时（实测多个品牌因此失败）。这三个值加起来不到 100 字节，就地取出即可。
 */
const API_CONFIG_SCRIPT = String.raw`(() => {
  const html = document.documentElement.innerHTML;
  const pick = (re) => { const m = re.exec(html); return m ? m[1] : null; };
  const apiKey = pick(/constructorApiKey\s*=\s*['"]([^'"]+)/);
  const filterName = pick(/var FILTER_NAME\s*=\s*['"]([^'"]+)/);
  const filterValue = pick(/var FILTER_VALUE\s*=\s*['"]([^'"]+)/);
  return apiKey && filterName && filterValue ? { apiKey: apiKey, filterName: filterName, filterValue: filterValue } : null;
})()`;

export function createSwansonFetcher(origin = "https://www.swansonvitamins.com"): SwansonFetcher {
  const holder = createPageHolder();
  let onOrigin = false;
  /** 同源 fetch 需要先停在站点自己的页面上；落一次很轻的首页即可，之后复用。 */
  const ensureOrigin = async (browser: { navigate(url: string): Promise<number> }) => {
    if (onOrigin) return;
    await browser.navigate(origin);
    onOrigin = true;
  };

  return {
    /**
     * 直接导航到接口地址再读正文，而不是在页面里 fetch。
     *
     * Constructor 的目录接口在 ac.cnstrc.com，跟站点不同源；页面内 fetch 会触发
     * CORS 预检，被浏览器拦掉且拿不到状态码（只会看到一个 rejected 的 Promise）。
     * 导航没有同源限制，JSON 会被渲染成纯文本，直接读 body 就是响应体。
     */
    /*
     * 每次请求用完就关标签页。
     *
     * page holder 在 CDP 超时后会换标签页重试，而复用的标签页可能还停在上一个地址，
     * 于是"取 JSON 接口"读回来的是上一个 HTML 页面——表现为 JSON.parse 报
     * Unexpected token '<'（1.1MB 的列表页很容易把 evaluate 拖超时）。
     * 关掉重开代价很小，换来的是每次都从干净的新标签页开始。
     */
    async text(url) {
      try {
      return await holder.run(async (browser) => {
        const status = await browser.navigate(url);
        if (status >= 400) {
          if (BLOCK_STATUSES.has(status)) throw new SwansonBlockedError(status, url);
          throw new Error(`Swanson HTTP ${status}: ${url}`);
        }
        /*
         * JSON 接口与 HTML 页面要读的东西不同：
         * - JSON 被 Chrome 渲染进一个 <pre>，读它的文字就是响应体；
         * - HTML 页面必须读源码——目录页要的 constructorApiKey 在 <script> 里，
         *   读 innerText 只会拿到渲染后的可见文字（实测 4058 字符 vs 源码 95 万），
         *   那里面根本没有它。
         */
        const here = await browser.evaluate<string>("location.href");
        if (!sameTarget(here, url)) throw new Error(`Swanson 导航未到达目标：期望 ${url}，实际 ${here}`);
        const body = await browser.evaluate<string>(String.raw`(() => {
          // 只有 HTML 页面才读源码（目录页要的 constructorApiKey 在 <script> 里，
          // 读 innerText 拿不到）。其余一律读正文——.js 接口的 content-type 是
          // application/javascript，白名单式判断会漏掉它，把 JSON 当 HTML 返回源码。
          const type = (document.contentType || '').toLowerCase();
          if (type.indexOf('html') >= 0) return document.documentElement.outerHTML;
          const pre = document.querySelector('pre');
          return pre ? pre.innerText : (document.body ? document.body.innerText : '');
        })()`);
        if (!body.trim()) throw new Error(`Swanson 响应为空：${url}`);
        return body;
      });
      } finally { onOrigin = false; await holder.close(); }
    },

    /**
     * 用页面内 fetch 取商品页源码，而不是导航过去。
     *
     * 导航等于完整渲染：950KB 主文档之外还要执行页面 JS、拉几十个子资源、等 load，
     * 实测把 CDP 拖到 Page.navigate / Runtime.evaluate 双双超时。
     * 同源 fetch 只取主文档、不渲染、不占标签页，抠完成分表只回传几百字节。
     *
     * （之前页面内 fetch 失败过一次，那是取跨域的 ac.cnstrc.com 被 CORS 拦；
     *   商品页与站点同源，不存在这个问题。）
     */
    async facts(url) {
      try {
      return await holder.run(async (browser) => {
        await ensureOrigin(browser);
        const found = await browser.evaluate<{ field: string; raw: string; other: string | null } | null>(
          factsViaFetchScript(url));
        if (!found) return null;
        const text = decodeFactsValue(found.raw);
        const other = found.other ? decodeFactsValue(found.other) : null;
        return other && !text.includes(other.slice(0, 40)) ? `${text}\n${other}` : text;
      });
      } catch (error) {
        // 出错可能是标签页坏了，关掉让下次重新落地
        onOrigin = false;
        await holder.close().catch(() => {});
        throw error;
      }
    },

    async apiConfig(url) {
      try {
        return await holder.run(async (browser) => {
          const status = await browser.navigate(url);
          if (status >= 400) {
            if (BLOCK_STATUSES.has(status)) throw new SwansonBlockedError(status, url);
            throw new Error(`Swanson HTTP ${status}: ${url}`);
          }
          return browser.evaluate<{ apiKey: string; filterName: string; filterValue: string } | null>(API_CONFIG_SCRIPT);
        });
      } finally { onOrigin = false; await holder.close(); }
    },

    async close() { onOrigin = false; await holder.close(); },
  };
}
