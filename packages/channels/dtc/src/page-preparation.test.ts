import { describe, expect, it, vi } from "vitest";
import { BrowserPages, HttpCapture, OriginalHtmlArchive } from "@crawl-automation/channels-core";
import { RetainedPublication, type ObjectStore } from "@crawl-automation/platform";
import { createDtcAdapter } from "./adapter.js";
import { DTC_BROWSER_POLICY, dtcSitePolicy } from "./site-policy.js";
import { sectionFacts, sectionPage, sectionUrl } from "./testing/product-sections.js";
import { preparationBrowser } from "./testing/preparation-browser.js";

function read(browser: ReturnType<typeof preparationBrowser>) {
  return browser.read(
    { url: sectionUrl, timeoutMs: 75000, ...DTC_BROWSER_POLICY },
    new AbortController().signal,
  );
}

describe("bounded DTC preparation before snapshot (inert DOM)", () => {
  it("opens own details, reveals an accordion and observes a scroll-loaded image", async () => {
    const browser = preparationBrowser(
      sectionPage({
        lower: `<section><h2>Supplement Facts</h2>
      <details id="facts"><summary>Facts</summary>${sectionFacts}</details>
      <button type="button" id="toggle" aria-expanded="false" aria-controls="label">Label</button>
      <div id="label" hidden></div></section>`,
      }),
    );
    const button = browser.document.querySelector("button");
    button?.addEventListener("click", () => {
      button.setAttribute("aria-expanded", "true");
      browser.document.querySelector("#label")?.removeAttribute("hidden");
    });
    browser.window.scrollBy.mockImplementation((_left, top) => {
      browser.window.scrollY += top;
      browser.document.querySelector("#label")?.setAttribute("data-lazy-observed", "true");
      const panel = browser.document.querySelector("#label");
      if (panel) {
        panel.innerHTML = '<img src="/lazy-label.jpg">';
      }
    });
    const result = await read(browser);
    expect(result.html).toMatch(/<details\b[^>]*\bopen\b/);
    expect(result.html).toContain('src="/lazy-label.jpg"');
    expect(result.preparation?.expanded).toEqual([
      { kind: "details", target: '[id="facts"]', label: "Facts", revealed: true },
      { kind: "accordion", target: '[id="toggle"]', label: "Label", revealed: true },
    ]);
    expect(result.preparation?.scrolls).toBeGreaterThan(0);
    expect(result.preparation?.elapsedMs).toBeLessThanOrEqual(8000);
    expect(browser.page.goto).toHaveBeenCalledTimes(1);
    expect(browser.requireAgent.mock.calls.length).toBeGreaterThan(3);
  });

  it("skips related details, links, form buttons and controls without an existing local panel", async () => {
    const browser = preparationBrowser(
      sectionPage({
        lower: `<section><h2>Supplement Facts</h2>
      <a href="/products/other" aria-expanded="false" aria-controls="panel">Label</a>
      <form><button aria-expanded="false" aria-controls="panel">Label</button></form>
      <button aria-expanded="false" aria-controls="missing">Label</button><div id="panel"></div>
      </section><section><h2>You may also like</h2><details><summary>Supplement Facts</summary>
      ${sectionFacts}</details></section>`,
      }),
    );
    const click = vi.fn();
    browser.document
      .querySelectorAll("button, a")
      .forEach((node) => node.addEventListener("click", click));
    const result = await read(browser);
    expect(click).not.toHaveBeenCalled();
    expect(result.preparation?.expanded).toEqual([]);
    expect(result.html).not.toMatch(/<details\b[^>]*\bopen\b/);
  });

  it("reports capped when a local toggle never reveals its panel", async () => {
    const browser = preparationBrowser(
      sectionPage({
        root: '<button type="button" aria-expanded="false" aria-controls="panel">Label</button><div id="panel"></div>',
      }),
    );
    const result = await read(browser);
    expect(result.preparation).toMatchObject({ ended: "capped", pending: { toggles: 1 } });
    expect(result.preparation?.expanded[0]?.revealed).toBe(false);
    expect(result.preparation?.elapsedMs).toBeLessThanOrEqual(8000);
  });

  it("waits for an asynchronously populated panel before capturing its text", async () => {
    const browser = preparationBrowser(
      sectionPage({
        root: '<button type="button" aria-expanded="false" aria-controls="panel">Ingredients</button><div id="panel"></div>',
      }),
    );
    const panel = browser.document.querySelector("#panel");
    const button = browser.document.querySelector("button");
    button?.addEventListener("click", () => {
      button.setAttribute("aria-expanded", "true");
      panel?.setAttribute("aria-busy", "true");
    });
    const settle = browser.page.waitForTimeout.getMockImplementation();
    let elapsed = 0;
    browser.page.waitForTimeout.mockImplementation(async (time) => {
      await settle?.(time);
      elapsed += time;
      if (elapsed >= 1500 && panel) {
        panel.innerHTML = sectionFacts;
        panel.removeAttribute("aria-busy");
      }
    });
    const result = await read(browser);
    expect(result.html).toContain("Magnesium 100 mg");
    expect(result.preparation).toMatchObject({ ended: "stable", pending: { panels: 0 } });
    expect(result.preparation?.elapsedMs).toBeGreaterThan(1500);
  });

  it("blocks a scripted navigation attempted by a button handler", async () => {
    const browser = preparationBrowser(
      sectionPage({
        root: '<button type="button" aria-expanded="false" aria-controls="panel">Label</button><div id="panel"></div>',
      }),
    );
    browser.document.querySelector("button")?.addEventListener("click", () => {
      const event = new Event("navigate", { cancelable: true });
      if (browser.window.navigation.dispatchEvent(event)) {
        browser.location.href = "https://other.example";
      }
    });
    const result = await read(browser);
    expect(result.url).toBe(sectionUrl);
    expect(result.preparation).toMatchObject({ blockedActions: 1, ended: "capped" });
  });
});

class Memory implements ObjectStore {
  data = new Map<string, Uint8Array>();
  async create(key: string, bytes: Uint8Array) {
    if (this.data.has(key)) {
      return "exists" as const;
    }
    this.data.set(key, bytes);
    return "created" as const;
  }
  async put(key: string, bytes: Uint8Array) {
    this.data.set(key, bytes);
  }
  async read(key: string) {
    return this.data.get(key) ?? null;
  }
}

it("archives expanded bytes and action metadata before parsing, then reuses them", async () => {
  const browser = preparationBrowser(
    sectionPage({
      lower: `<section><details id="facts"><summary>Supplement Facts</summary>${sectionFacts}</details></section>`,
    }),
  );
  const adapter = createDtcAdapter([
    dtcSitePolicy({ siteKey: "shop.example", platform: "shopify", catalogUrl: null }),
  ]);
  const remote = new Memory();
  const archive = new OriginalHtmlArchive(new RetainedPublication(new Memory(), remote), {
    channel: "dtc",
    maxBytes: 100000,
    capture: {
      ...adapter.productAddress(sectionUrl),
      operationId: "prepared-page",
      sessionId: "prepared-page",
      sourceId: "section-source",
    },
  });
  const capture = new HttpCapture(
    new BrowserPages(browser, {
      routeId: "test",
      egressId: "test",
      channels: { dtc: DTC_BROWSER_POLICY },
    }),
  );
  const parse = vi.spyOn(adapter, "parseProduct").mockImplementation((page) => {
    expect([...remote.data.keys()].some((key) => key.endsWith("original.json"))).toBe(true);
    expect(page.html).toBe(browser.document.documentElement.outerHTML);
    return createDtcAdapter([
      dtcSitePolicy({ siteKey: "shop.example", platform: "shopify", catalogUrl: null }),
    ]).parseProduct(page);
  });
  const signal = new AbortController().signal;
  const result = await capture.capture(adapter, archive, signal);
  expect(result.status).toBe("page");
  const receipt = [...remote.data.entries()].find(([key]) => key.endsWith("original.json"));
  expect(
    JSON.parse(Buffer.from(receipt?.[1] ?? []).toString()).fetchedVia.preparation,
  ).toMatchObject({
    expanded: [{ kind: "details", revealed: true }],
    ended: "stable",
  });
  const original = [...remote.data.entries()].find(([key]) => key.endsWith("original.html"));
  expect(Buffer.from(original?.[1] ?? []).toString()).toBe(
    browser.document.documentElement.outerHTML,
  );
  await capture.capture(adapter, archive, signal);
  expect(browser.read).toHaveBeenCalledTimes(1);
  expect(parse).toHaveBeenCalledTimes(2);
});
