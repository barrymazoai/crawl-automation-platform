import { randomUUID } from "node:crypto";

const NETWORK_METHODS = [
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
];

function timeoutOptions(options = {}) {
  if (!options || typeof options !== "object") return options;
  const { timeoutMs, ...rest } = options;
  return timeoutMs == null ? rest : { ...rest, timeout: timeoutMs };
}

function withTimeout(operation, timeoutMs, label) {
  if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) <= 0) return operation;
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`worker_cdp_timeout:${label}`)), Number(timeoutMs));
    }),
  ]).finally(() => clearTimeout(timer));
}

function wrapLocator(locator) {
  return {
    count: () => locator.count(),
    first: () => wrapLocator(locator.first()),
    nth: (index) => wrapLocator(locator.nth(index)),
    isVisible: (options) => locator.isVisible(timeoutOptions(options)),
    click: (options) => locator.click(timeoutOptions(options)),
    press: (key, options) => locator.press(key, timeoutOptions(options)),
    getByRole: (role, options) => wrapLocator(locator.getByRole(role, options)),
    getByText: (text, options) => wrapLocator(locator.getByText(text, options)),
    locator: (selector, options) => wrapLocator(locator.locator(selector, options)),
  };
}

function createEventBuffer(session) {
  let sequence = 0;
  const events = [];
  const waiters = new Set();
  const wake = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  for (const method of NETWORK_METHODS) {
    session.on(method, (params) => {
      events.push({ sequence: ++sequence, method, params });
      if (events.length > 10_000) events.splice(0, events.length - 10_000);
      wake();
    });
  }

  return {
    async read({ afterSequence, methods = NETWORK_METHODS, limit = 1_000, timeoutMs = 0 } = {}) {
      const cursor = Number.isFinite(Number(afterSequence)) ? Number(afterSequence) : sequence;
      const allowed = new Set(methods);
      const select = () => events.filter((event) =>
        event.sequence > cursor && allowed.has(event.method)
      );
      let selected = select();
      if (selected.length === 0 && timeoutMs > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            waiters.delete(done);
            resolve();
          }, timeoutMs);
          const done = () => {
            clearTimeout(timer);
            waiters.delete(done);
            resolve();
          };
          waiters.add(done);
        });
        selected = select();
      }
      const page = selected.slice(0, Math.max(1, limit));
      return {
        events: page,
        cursor: page.at(-1)?.sequence ?? sequence,
        hasMore: selected.length > page.length,
        truncated: events.length >= 10_000,
      };
    },
    close() {
      waiters.clear();
    },
  };
}

async function wrapPage(context, page) {
  const session = await context.newCDPSession(page);
  const eventBuffer = createEventBuffer(session);
  const id = `worker-cdp-${randomUUID()}`;

  const playwright = {
    evaluate(fn, arg, options = {}) {
      return withTimeout(page.evaluate(fn, arg), options.timeoutMs, "evaluate");
    },
    locator(selector, options) {
      return wrapLocator(page.locator(selector, options));
    },
    getByText(text, options) {
      return wrapLocator(page.getByText(text, options));
    },
    waitForTimeout(timeoutMs) {
      return page.waitForTimeout(timeoutMs);
    },
    waitForLoadState(options = {}) {
      return page.waitForLoadState(options.state ?? "load", {
        timeout: options.timeoutMs,
      });
    },
    async domSnapshot() {
      const body = page.locator("body");
      if (typeof body.ariaSnapshot === "function") return body.ariaSnapshot();
      return page.content();
    },
  };

  return {
    id,
    playwright,
    goto(url, options = {}) {
      return page.goto(url, {
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? 30_000,
      });
    },
    reload(options = {}) {
      return page.reload({
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? 30_000,
      });
    },
    async url() {
      return page.url();
    },
    screenshot(options = {}) {
      return page.screenshot(options);
    },
    async close() {
      eventBuffer.close();
      await session.detach().catch(() => {});
      await page.close();
    },
    capabilities: {
      async list() {
        return [{ id: "cdp" }];
      },
      async get(capabilityId) {
        if (capabilityId !== "cdp") return null;
        return {
          send: (method, params = {}) => session.send(method, params),
          readEvents: (options) => eventBuffer.read(options),
        };
      },
    },
    _page: page,
  };
}

export async function connectWorkerBrowser(options = {}) {
  const cdpUrl = options.cdpUrl ?? process.env.CRAWL_BROWSER_CDP_URL;
  if (!cdpUrl) throw new Error("CRAWL_BROWSER_CDP_URL is required for worker_cdp");
  const chromium = options.chromium
    ?? (await import("playwright-core")).chromium;
  const browser = await chromium.connectOverCDP(cdpUrl, {
    timeout: options.timeoutMs ?? 20_000,
  });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error("worker_cdp_default_context_missing");
  }
  const wrapped = new WeakMap();
  const getTab = async (page) => {
    let tab = wrapped.get(page);
    if (!tab) {
      tab = await wrapPage(context, page);
      wrapped.set(page, tab);
    }
    return tab;
  };

  return {
    mode: "worker_cdp",
    cdpUrl,
    async nameSession() {},
    async documentation() {
      return "worker_cdp: Playwright connects to the Browser Node lane-local Chrome over localhost CDP.";
    },
    tabs: {
      async new() {
        return getTab(await context.newPage());
      },
      async list() {
        return Promise.all(context.pages().map(getTab));
      },
    },
    async disconnect() {
      await browser.close();
    },
  };
}

export function createBrowserJsonFetcher(tab) {
  if (!tab?.playwright?.evaluate) throw new Error("worker_cdp_tab_required");
  return async (url, timeoutMs = 12_000) => {
    const result = await tab.playwright.evaluate(async ({ target, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(target, {
          credentials: "include",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        return {
          ok: response.ok,
          contentType: response.headers.get("content-type") || "",
          body: await response.text(),
        };
      } finally {
        clearTimeout(timer);
      }
    }, { target: url, timeout: timeoutMs }, { timeoutMs: timeoutMs + 2_000 });
    if (!result?.ok || !/json/i.test(result.contentType || "")) return null;
    try { return JSON.parse(result.body); }
    catch { return null; }
  };
}

/**
 * 页面内同源 fetch 商品页 HTML（不导航、不渲染整页）：独立站的成分表经常只在页面里、不在接口里，
 * Shopify HTTP 通道枚举完后用它"去页面看一眼"。返回 HTML 字符串，非 HTML/失败返回 null。
 */
export function createBrowserHtmlFetcher(tab) {
  if (!tab?.playwright?.evaluate) throw new Error("worker_cdp_tab_required");
  return async (url, timeoutMs = 15_000) => {
    const result = await tab.playwright.evaluate(async ({ target, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(target, {
          credentials: "include",
          headers: { accept: "text/html,application/xhtml+xml" },
          signal: controller.signal,
        });
        return { ok: response.ok, contentType: response.headers.get("content-type") || "", body: await response.text() };
      } finally {
        clearTimeout(timer);
      }
    }, { target: url, timeout: timeoutMs }, { timeoutMs: timeoutMs + 2_000 });
    if (!result?.ok || !/html/i.test(result.contentType || "")) return null;
    return typeof result.body === "string" && result.body.length > 0 ? result.body : null;
  };
}

export function createBrowserImageFetcher(tab) {
  if (!tab?.goto) throw new Error("worker_cdp_tab_required");
  return async (url) => {
    const response = await tab.goto(url, { waitUntil: "commit", timeoutMs: 30_000 });
    if (!response || !response.ok()) throw new Error(`browser_image_http_${response?.status?.() ?? 0}`);
    const bytes = Buffer.from(await response.body());
    if (bytes.length === 0) throw new Error("browser_image_empty");
    return { bytes, mime: response.headers()["content-type"] || "" };
  };
}

export function createBrowserProductDataFetcher(tab) {
  return async (productUrl) => {
    let dataUrl;
    try {
      const parsed = new URL(productUrl);
      const match = /^(.*\/products\/)([^/?#]+)/.exec(parsed.pathname);
      if (!match) return null;
      dataUrl = `${parsed.origin}${match[1]}${match[2]}.json`;
    } catch {
      return null;
    }
    const response = await tab.goto(dataUrl, { waitUntil: "commit", timeoutMs: 20_000 });
    if (!response || !response.ok()) return null;
    let body;
    try { body = JSON.parse((await response.body()).toString("utf8")); }
    catch { return null; }
    return body && typeof body === "object" ? body.product ?? body : null;
  };
}
