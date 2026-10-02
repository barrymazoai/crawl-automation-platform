import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { egoLocator } from "./ego-native-locator.mjs";

/** Adapts the existing harvest primitives inside Ego's native Node runtime. No CDP server or Playwright. */
export function createEgoBrowser({ task, page, listTaskSpaces, workDir, productUrl = null }) {
  const guard = async () => {
    const space = (await listTaskSpaces()).find(item => (item.id ?? item.spaceId) === task.spaceId);
    if (!space || space.ownership !== "agent") throw new Error("SOURCE.BROWSER_USER_CONTROL");
    const owned = (await task.tabs()).find(item => item.targetId === page.targetId);
    if (!owned || owned.openedBy !== "agent") throw new Error("SOURCE.TARGET_MISSING");
  };
  const call = async (method, ...args) => { await guard(); return page[method](...args); };
  const tab = {
    id: page.targetId,
    playwright: {
      evaluate: (fn, arg) => call("evaluate", fn, arg),
      locator: selector => egoLocator(page, guard, { css: selector }),
      getByText: (text, options = {}) => egoLocator(page, guard, { text, exact: options.exact }),
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
      readEvents: createEventReader(page, guard),
    } : null },
  };
  const hooks = {
    fetchPageHtml: async url => {
      if (await tab.url() !== url) await tab.goto(url);
      return tab.playwright.evaluate(() => document.documentElement.outerHTML);
    },
    fetchProductData: async url => {
      const target = new URL(url);
      if (!/\/products\/[^/]+\/?$/.test(target.pathname)) return null;
      target.search = ""; target.pathname = target.pathname.replace(/\/$/, "") + ".json";
      const body = await call("evaluate", async targetUrl => {
        const response = await fetch(targetUrl, { credentials: "include" });
        if (response.status === 404 || !response.headers.get("content-type")?.includes("json")) return null;
        if (!response.ok) throw new Error(`SOURCE.PRODUCT_DATA_HTTP:${response.status}`);
        return response.json();
      }, target.href);
      return body?.product ?? body;
    },
    fetchImage: url => readImage({ page, guard, workDir }, url),
  };
  return { mode: "ego-native", productUrl, harvestHooks: hooks, tab, tabs: {
    new: async () => { await guard(); return tab; },
    list: async () => { await guard(); return [tab]; },
  }, disconnect: async () => { await guard(); } };
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
