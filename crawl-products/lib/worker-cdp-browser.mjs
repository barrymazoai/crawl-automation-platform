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

function wrapLocator(locator, guard = async () => {}) {
  return {
    count: async () => { await guard(); return locator.count(); },
    first: () => wrapLocator(locator.first(), guard),
    nth: (index) => wrapLocator(locator.nth(index), guard),
    isVisible: async (options) => { await guard(); return locator.isVisible(timeoutOptions(options)); },
    click: async (options) => { await guard(); return locator.click(timeoutOptions(options)); },
    press: async (key, options) => { await guard(); return locator.press(key, timeoutOptions(options)); },
    getByRole: (role, options) => wrapLocator(locator.getByRole(role, options), guard),
    getByText: (text, options) => wrapLocator(locator.getByText(text, options), guard),
    locator: (selector, options) => wrapLocator(locator.locator(selector, options), guard),
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

async function wrapPage(context, page, guard = async () => {}, controllerOwned = false) {
  await guard();
  const session = await context.newCDPSession(page);
  const eventBuffer = createEventBuffer(session);
  const id = `worker-cdp-${randomUUID()}`;

  const playwright = {
    async evaluate(fn, arg, options = {}) {
      await guard();
      return withTimeout(page.evaluate(fn, arg), options.timeoutMs, "evaluate");
    },
    locator(selector, options) {
      return wrapLocator(page.locator(selector, options), guard);
    },
    getByText(text, options) {
      return wrapLocator(page.getByText(text, options), guard);
    },
    waitForTimeout(timeoutMs) {
      return page.waitForTimeout(timeoutMs);
    },
    async waitForLoadState(options = {}) {
      await guard();
      return page.waitForLoadState(options.state ?? "load", {
        timeout: options.timeoutMs,
      });
    },
    async domSnapshot() {
      await guard();
      const body = page.locator("body");
      if (typeof body.ariaSnapshot === "function") return body.ariaSnapshot();
      return page.content();
    },
  };

  return {
    id,
    playwright,
    async goto(url, options = {}) {
      await guard();
      return page.goto(url, {
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? 30_000,
      });
    },
    async reload(options = {}) {
      await guard();
      return page.reload({
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? 30_000,
      });
    },
    async url() {
      return page.url();
    },
    async screenshot(options = {}) {
      await guard();
      return page.screenshot(options);
    },
    async close() {
      eventBuffer.close();
      await session.detach().catch(() => {});
      if (!controllerOwned) { await guard(); await page.close(); }
    },
    capabilities: {
      async list() {
        return [{ id: "cdp" }];
      },
      async get(capabilityId) {
        if (capabilityId !== "cdp") return null;
        return {
          send: async (method, params = {}) => {
            await guard();
            if (controllerOwned && /^(Browser|Target)\./.test(method)) throw new Error("SOURCE.TARGET_SCOPE");
            return session.send(method, params);
          },
          readEvents: (options) => eventBuffer.read(options),
        };
      },
    },
    ...(controllerOwned ? {} : { _page: page }),
  };
}

export async function connectWorkerBrowser(options = {}) {
  const cdpUrl = options.cdpUrl ?? process.env.CRAWL_BROWSER_CDP_URL;
  if (!cdpUrl) throw new Error("CRAWL_BROWSER_CDP_URL is required for worker_cdp");
  const taskFile = process.env.CRAWL_BROWSER_TASK_FILE;
  const { readFile, stat } = await import("node:fs/promises");
  const task = taskFile ? JSON.parse(await readFile(taskFile, "utf8")) : null;
  const guard = async () => {
    if (!task) return;
    const live = JSON.parse(await readFile(taskFile, "utf8").catch(() => { throw new Error("SOURCE.SESSION_UNAVAILABLE"); }));
    if (JSON.stringify(live) !== JSON.stringify(task) || Date.now() >= task.expiresAt || task.endpoint !== cdpUrl) throw new Error("SOURCE.SESSION_UNAVAILABLE");
    try { await stat(task.pauseFile); throw new Error("SOURCE.BROWSER_USER_CONTROL"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const version = await (await fetch(new URL("/json/version", cdpUrl), { signal: AbortSignal.timeout(5000) })).json();
    if (version.webSocketDebuggerUrl !== cdpUrl.replace("http:", "ws:").replace(/\/$/, "") + "/devtools/browser/" + task.instanceId) throw new Error("SOURCE.BROWSER_INSTANCE_CHANGED");
  };
  await guard();
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
      tab = await wrapPage(context, page, guard, !!task);
      wrapped.set(page, tab);
    }
    return tab;
  };

  let ownedPage;
  if (task) {
    for (const page of context.pages()) {
      const session = await context.newCDPSession(page);
      try { const result = await session.send("Target.getTargetInfo"); if (result.targetInfo.targetId === task.targetId) ownedPage = page; } finally { await session.detach(); }
    }
    if (!ownedPage) { await browser.close(); throw new Error("SOURCE.TARGET_MISSING"); }
  }
  return {
    mode: "worker_cdp",
    cdpUrl,
    async nameSession() {},
    async documentation() {
      return "worker_cdp: Playwright connects to the Browser Node lane-local Chrome over localhost CDP.";
    },
    tabs: {
      async new() {
        await guard();
        return getTab(ownedPage ?? await context.newPage());
      },
      async list() {
        await guard();
        return Promise.all((ownedPage ? [ownedPage] : context.pages()).map(getTab));
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
 * Same task tab only. Retain HTML before image navigation and page cleanup.
 * Ordinary fetch failures allow one DOM capture; access/control boundaries never do.
 */
export function createBrowserHtmlFetcher(tab) {
  if (!tab?.playwright?.evaluate) throw new Error("worker_cdp_tab_required");
  return async (url, timeoutMs = 15_000) => {
    const expected = new URL(url);
    const samePage = raw => { const u = new URL(raw); return u.origin === expected.origin && u.pathname === expected.pathname && u.search === expected.search; };
    let fetchError;
    try {
      const result = await tab.playwright.evaluate(async ({ target, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(target, {
          credentials: "include",
          headers: { accept: "text/html,application/xhtml+xml" },
          signal: controller.signal,
        });
        return { ok: response.ok, status: response.status, url: response.url, contentType: response.headers.get("content-type") || "", body: await response.text() };
      } finally {
        clearTimeout(timer);
      }
    }, { target: url, timeout: timeoutMs }, { timeoutMs: timeoutMs + 2_000 });
      if ([401, 403, 429].includes(result?.status)) throw new Error(`SOURCE.HTML_ACCESS_BLOCKED:${result.status}`);
      if (result?.ok && samePage(result.url) && /html/i.test(result.contentType || "") && typeof result.body === "string" && result.body.length > 500) return result.body;
      throw new Error(`html_fetch_invalid:status=${result?.status ?? 0};type=${result?.contentType ?? ""};bytes=${result?.body?.length ?? 0}`);
    } catch (error) {
      if (/SOURCE\.|EACCES|EPERM|EROFS/.test(String(error))) throw error;
      fetchError = String(error).slice(0, 500);
    }
    try {
      const response = await tab.goto(url, { waitUntil: "domcontentloaded", timeoutMs });
      if ([401, 403, 429].includes(response?.status?.())) throw new Error(`SOURCE.HTML_ACCESS_BLOCKED:${response.status()}`);
      if (!response?.ok?.()) throw new Error(`html_dom_http:${response?.status?.() ?? 0}`);
      const dom = await tab.playwright.evaluate(() => ({ url: location.href, type: document.contentType, body: document.documentElement.outerHTML }), undefined, { timeoutMs });
      if (!samePage(dom.url) || !/html/i.test(dom.type || "") || typeof dom.body !== "string" || dom.body.length <= 500) throw new Error(`html_dom_invalid:bytes=${dom?.body?.length ?? 0}`);
      return dom.body;
    } catch (error) {
      if (/SOURCE\.|EACCES|EPERM|EROFS/.test(String(error))) throw error;
      throw new Error(`html_capture_failed:fetch=${fetchError};dom=${String(error).slice(0, 500)}`);
    }
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
