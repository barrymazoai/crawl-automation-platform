import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { egoLocator } from "./ego-native-locator.mjs";
import { retainNativeOriginal } from "./ego-native-originals.mjs";

/** Adapts the existing harvest primitives inside Ego's native Node runtime. No CDP server or Playwright. */
export function createEgoBrowser({ task, page, targetId = page.targetId, listTaskSpaces, workDir, productUrl = null, captureMode = process.env.CRAWL_DTC_CAPTURE_MODE }) {
  if (typeof targetId !== "string" || !targetId) throw new Error("SOURCE.TARGET_MISSING");
  const guard = async () => {
    const space = (await listTaskSpaces()).find(item => (item.id ?? item.spaceId) === task.spaceId);
    if (!space || space.ownership !== "agent") throw new Error("SOURCE.BROWSER_USER_CONTROL");
    const owned = (await task.tabs()).find(item => item.targetId === targetId);
    if (!owned || owned.openedBy !== "agent") throw new Error("SOURCE.TARGET_MISSING");
    return owned.page ?? page;
  };
  const call = async (method, ...args) => { const owned = await guard(); return owned[method](...args); };
  const scoped = Object.fromEntries(["evaluate", "click", "press", "events", "fetch"].map(method => [method, (...args) => call(method, ...args)]));
  const tab = {
    id: targetId,
    playwright: {
      // Ego rejects explicit undefined; the legacy harvest API uses it for an omitted argument.
      evaluate: (fn, arg) => arg === undefined ? call("evaluate", fn) : call("evaluate", fn, arg),
      locator: selector => egoLocator(scoped, guard, { css: selector }),
      getByText: (text, options = {}) => egoLocator(scoped, guard, { text, exact: options.exact }),
      domSnapshot: () => call("snapshot", { scope: "full_page" }),
      waitForTimeout: ms => call("waitForTimeout", ms),
      waitForLoadState: (options = {}) => call("waitForLoadState", options.state ?? "load", { timeout: options.timeoutMs }),
    },
    async goto(url, options = {}) {
      await call("goto", url, { waitUntil: options.waitUntil ?? "domcontentloaded", timeout: options.timeoutMs ?? 30_000 });
      const status = await call("evaluate", () => performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0);
      return { ok: () => status >= 200 && status < 400, status: () => status };
    },
    reload: (options = {}) => call("reload", { timeout: options.timeoutMs, waitUntil: options.waitUntil ?? "domcontentloaded" }),
    url: () => call("url"),
    async screenshot(options = {}) {
      const path = options.path ?? join(workDir, `screenshot-${randomUUID()}.png`);
      await call("screenshot", { ...options, path });
      return readFile(path);
    },
    // The host owns closure and absence verification after all retained evidence has been acquired.
    close: async () => { await guard(); },
    capabilities: { list: async () => [{ id: "cdp" }], get: async id => id === "cdp" ? {
      send: async (method, params = {}) => {
        if (/^(Target|Browser)\./.test(method)) throw new Error("SOURCE.TARGET_SCOPE");
        return call("cdp", method, params);
      },
      readEvents: createEventReader(scoped, guard),
    } : null },
  };
  const hooks = {
    fetchPageSource: async url => {
      const actual = await tab.url();
      assertPageState(actual, url);
      const html = await tab.playwright.evaluate(() => document.documentElement.outerHTML);
      const after = await tab.url();
      const receipt = await retainNativeOriginal(workDir, { url: actual, kind: "html", bytes: html,
        observation: { kind: "rendered-dom", requestedUrl: url, actualUrl: actual, afterUrl: after, targetId } });
      if (actual !== after) throw new Error("SOURCE.PAGE_STATE_CHANGED");
      return { text: html, url: actual, receipt };
    },
    fetchProductSource: async url => {
      const target = new URL(url);
      if (!/\/products\/[^/]+\/?$/.test(target.pathname)) return null;
      target.search = ""; target.pathname = target.pathname.replace(/\/$/, "") + ".json";
      assertPageState(await tab.url(), url);
      const response = await call("evaluate", async targetUrl => {
        const response = await fetch(targetUrl, { credentials: "include", redirect: "error", signal: AbortSignal.timeout(10000) });
        return { status: response.status, ok: response.ok, url: response.url, type: response.headers.get("content-type"), text: await response.text() };
      }, target.href);
      const receipt = response.text ? await retainNativeOriginal(workDir, { url: target.href, kind: response.type?.includes("json") ? "json" : "http", bytes: response.text,
        observation: { kind: "http-response", status: response.status, finalUrl: response.url, targetId } }) : null;
      if (response.status === 404 || !response.type?.includes("json")) return null;
      if (!response.ok) throw new Error(`SOURCE.PRODUCT_DATA_HTTP:${response.status}`);
      const body = JSON.parse(response.text);
      const product = body?.product ?? body;
      if (product?.handle !== new URL(url).pathname.replace(/\/$/, "").split("/").at(-1)
        || !Array.isArray(product?.variants) || (response.url && response.url !== target.href)) {
        throw new Error("SOURCE.PRODUCT_DATA_IDENTITY");
      }
      return { product, text: response.text, url: response.url || target.href, receipt };
    },
    fetchImage: url => readImage({ page: scoped, guard, workDir }, url),
    retainAttempt: value => retainNativeOriginal(workDir, { url: productUrl, kind: "harvest", bytes: JSON.stringify(value) }),
  };
  hooks.fetchPageHtml = async url => (await hooks.fetchPageSource(url)).text;
  hooks.fetchProductData = async url => (await hooks.fetchProductSource(url))?.product ?? null;
  return { mode: "ego-native", captureMode, productUrl, harvestHooks: hooks, tab, tabs: {
    new: async () => { await guard(); return tab; },
    list: async () => { await guard(); return [tab]; },
  }, disconnect: async () => { await guard(); } };
}

function assertPageState(actual, expected) {
  const current = new URL(actual), requested = new URL(expected);
  if (current.origin !== requested.origin || current.pathname.replace(/\/$/, "") !== requested.pathname.replace(/\/$/, "")) {
    throw new Error("SOURCE.PAGE_IDENTITY");
  }
  for (const name of ["variant", "variation_id"]) {
    if (requested.searchParams.has(name) && current.searchParams.get(name) !== requested.searchParams.get(name)) {
      throw new Error("SOURCE.PAGE_VARIANT");
    }
  }
}

function createEventReader(page, guard) {
  let sequence = 0;
  let events = [];
  return async ({ afterSequence = 0, methods, limit = 1000 } = {}) => {
    await guard();
    const incoming = await page.events();
    for (const event of Array.isArray(incoming) ? incoming : incoming.events ?? []) {
      events.push({ ...event, sequence: ++sequence });
    }
    const truncated = events.length > 10000;
    events = events.slice(-10000);
    const selected = events.filter(event => event.sequence > afterSequence && (!methods || methods.includes(event.method)));
    const result = selected.slice(0, limit);
    return { events: result, cursor: result.at(-1)?.sequence ?? sequence, hasMore: selected.length > limit, truncated };
  };
}

async function readImage({ page, guard, workDir }, url) {
  await guard();
  const path = join(workDir, `image-${randomUUID()}.bin`);
  const response = await page.fetch(url, { saveAs: path, timeout: 30000 });
  if (!response || response.status < 200 || response.status >= 300) throw new Error(`SOURCE.IMAGE_HTTP:${response?.status}`);
  const bytes = await readFile(path);
  await retainNativeOriginal(workDir, { url, kind: "image", bytes });
  await unlink(path);
  if (!bytes.length) throw new Error("SOURCE.IMAGE_EMPTY");
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg"
      : bytes.subarray(8, 12).toString() === "WEBP" ? "image/webp"
        : bytes.subarray(0, 3).toString() === "GIF" ? "image/gif"
          : bytes.subarray(0, 512).toString().includes("<svg") ? "image/svg+xml"
            : bytes.subarray(4, 12).toString().includes("ftypavif") ? "image/avif" : null;
  if (!mime) throw new Error("SOURCE.IMAGE_TYPE_UNVERIFIED");
  return { bytes, mime };
}
