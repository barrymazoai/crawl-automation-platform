import { describe, expect, it, vi } from "vitest";

import {
  connectWorkerBrowser,
  createBrowserImageFetcher,
  createBrowserJsonFetcher,
  createBrowserProductDataFetcher,
} from "./worker-cdp-browser.mjs";

function fakePlaywright() {
  const listeners = new Map();
  const locator = {
    count: vi.fn(async () => 1),
    first: vi.fn(() => locator),
    nth: vi.fn(() => locator),
    isVisible: vi.fn(async () => true),
    click: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    getByRole: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    locator: vi.fn(() => locator),
    ariaSnapshot: vi.fn(async () => "- document"),
  };
  const page = {
    evaluate: vi.fn(async (fn, arg) => {
      if (arg?.target) return { ok: true, contentType: "application/json", body: '{"products":[]}' };
      return fn(arg);
    }),
    locator: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    waitForTimeout: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    content: vi.fn(async () => "<html></html>"),
    goto: vi.fn(async (url) => ({
      ok: () => true,
      status: () => 200,
      body: async () => Buffer.from(String(url).endsWith(".json") ? '{"product":{"id":42}}' : "image"),
      headers: () => ({ "content-type": String(url).endsWith(".json") ? "application/json" : "image/webp" }),
    })),
    reload: vi.fn(async () => {}),
    url: vi.fn(() => "https://shop.test/"),
    screenshot: vi.fn(async () => Buffer.from("png")),
    close: vi.fn(async () => {}),
  };
  const session = {
    on: vi.fn((method, listener) => listeners.set(method, listener)),
    send: vi.fn(async () => ({})),
    detach: vi.fn(async () => {}),
  };
  const context = {
    newPage: vi.fn(async () => page),
    pages: vi.fn(() => [page]),
    newCDPSession: vi.fn(async () => session),
  };
  const browser = {
    contexts: vi.fn(() => [context]),
    close: vi.fn(async () => {}),
  };
  const chromium = { connectOverCDP: vi.fn(async () => browser) };
  return { chromium, browser, context, page, session, locator, listeners };
}

describe("worker CDP browser adapter", () => {
  it("exposes the tab/playwright contract used by crawl-products", async () => {
    const fake = fakePlaywright();
    const binding = await connectWorkerBrowser({ cdpUrl: "http://127.0.0.1:9223", chromium: fake.chromium });
    const tab = await binding.tabs.new();

    await tab.goto("https://shop.test/");
    await tab.playwright.locator("body").press("PageDown", { timeoutMs: 500 });
    expect(await tab.url()).toBe("https://shop.test/");
    expect(await tab.screenshot()).toEqual(Buffer.from("png"));
    expect(fake.chromium.connectOverCDP).toHaveBeenCalledWith(
      "http://127.0.0.1:9223",
      { timeout: 20_000 },
    );
    expect(fake.locator.press).toHaveBeenCalledWith("PageDown", { timeout: 500 });

    const cdp = await tab.capabilities.get("cdp");
    fake.listeners.get("Network.responseReceived")?.({ requestId: "1", response: { url: "https://shop.test/" } });
    const events = await cdp.readEvents({ afterSequence: 0, methods: ["Network.responseReceived"] });
    expect(events.events).toHaveLength(1);

    await binding.disconnect();
    expect(fake.browser.close).toHaveBeenCalledOnce();
  });

  it("uses the rendered page as a same-origin JSON fallback", async () => {
    const fake = fakePlaywright();
    const binding = await connectWorkerBrowser({ cdpUrl: "http://127.0.0.1:9224", chromium: fake.chromium });
    const tab = await binding.tabs.new();
    const fetchJson = createBrowserJsonFetcher(tab);
    await expect(fetchJson("https://shop.test/products.json")).resolves.toEqual({ products: [] });
    const fetchProductData = createBrowserProductDataFetcher(tab);
    await expect(fetchProductData("https://shop.test/products/alpha?variant=1")).resolves.toEqual({ id: 42 });
  });

  it("downloads original image bytes through Chrome rather than host fetch", async () => {
    const fake = fakePlaywright();
    const binding = await connectWorkerBrowser({ cdpUrl: "http://127.0.0.1:9225", chromium: fake.chromium });
    const tab = await binding.tabs.new();
    const fetchImage = createBrowserImageFetcher(tab);
    await expect(fetchImage("https://cdn.test/original.webp")).resolves.toEqual({
      bytes: Buffer.from("image"),
      mime: "image/webp",
    });
    expect(fake.page.goto).toHaveBeenCalledWith("https://cdn.test/original.webp", {
      waitUntil: "commit",
      timeout: 30_000,
    });
  });
});
