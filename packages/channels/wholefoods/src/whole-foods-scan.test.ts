import { readFileSync } from "node:fs";
import {
  egoErrors,
  pageRoundScript,
  type BrowserPage,
  type ObjectStore,
} from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { WholeFoodsBrandScan } from "./whole-foods-brand-scan.js";
import { ensureWholeFoodsStore } from "./whole-foods-store-setup.js";
import { wholeFoodsStoreCookie, type WholeFoodsStore } from "./whole-foods-store.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const store: WholeFoodsStore = { storeId: "10259", label: "The Alameda", postalCode: "95126" };
const sourceUrl =
  "https://www.wholefoodsmarket.com/grocery/search?k=Nordic+Naturals&rh=p_123%3A234060";
const signal = () => AbortSignal.timeout(5_000);

class MemoryStore implements ObjectStore {
  readonly data = new Map<string, Uint8Array>();
  async read(key: string) {
    return this.data.get(key) ?? null;
  }
  async create(key: string, bytes: Uint8Array) {
    if (this.data.has(key)) {
      return "exists" as const;
    }
    this.data.set(key, Buffer.from(bytes));
    return "created" as const;
  }
}

function scanSetup(html: string, ended: BrowserPage["scroll"]["ended"] = "stable") {
  const drawn: BrowserPage = {
    url: sourceUrl,
    status: 200,
    html,
    ready: true,
    scroll: { rounds: 7, ended },
  };
  const browser = { provider: "ego-lite/2", read: vi.fn(async () => drawn) };
  const remote = new MemoryStore();
  return { browser, remote, scanner: new WholeFoodsBrandScan({ browser, remote, store }) };
}

describe("Whole Foods brand scan", () => {
  it("archives the drawn search before reading it, and is complete once scrolled to its end", async () => {
    const { browser, remote, scanner } = scanSetup(fixture("search-nordic-naturals.html"));
    const scan = await scanner.scan({ scanId: "scan-1", sourceUrl }, signal());
    expect(scan).toMatchObject({
      complete: true,
      soldHere: true,
      archiveKeys: ["v3/brand-scans/scan-1/search.html"],
    });
    expect(scan.pages[0]?.products).toHaveLength(3);
    const record = JSON.parse(
      Buffer.from(remote.data.get("v3/brand-scans/scan-1/search.record.json") ?? []).toString(),
    );
    expect(record).toMatchObject({
      storeId: "10259",
      scroll: { ended: "stable" },
      provider: "ego-lite/2",
    });
    expect(browser.read).toHaveBeenCalledWith(
      expect.objectContaining({ url: sourceUrl }),
      expect.anything(),
    );
  });

  it("reads an archived scan again without drawing the page again", async () => {
    const { browser, remote, scanner } = scanSetup(fixture("search-nordic-naturals.html"));
    await scanner.scan({ scanId: "scan-2", sourceUrl }, signal());
    const again = await new WholeFoodsBrandScan({ browser, remote, store }).scan(
      { scanId: "scan-2", sourceUrl },
      signal(),
    );
    expect(again.pages[0]?.products).toHaveLength(3);
    expect(browser.read).toHaveBeenCalledOnce();
  });

  it("is partial when scrolling stopped at the round limit", async () => {
    const { scanner } = scanSetup(fixture("search-nordic-naturals.html"), "capped");
    expect(await scanner.scan({ scanId: "scan-3", sourceUrl }, signal())).toMatchObject({
      complete: false,
    });
  });

  it("refuses an archive whose record never finished, and draws nothing", async () => {
    const { browser, remote, scanner } = scanSetup(fixture("search-nordic-naturals.html"));
    remote.data.set("v3/brand-scans/scan-4/search.html", Buffer.from("<html></html>"));
    await expect(scanner.scan({ scanId: "scan-4", sourceUrl }, signal())).rejects.toMatchObject({
      code: "BRAND_SCAN.ARCHIVE_UNVERIFIED",
    });
    expect(browser.read).not.toHaveBeenCalled();
  });
});

describe("Whole Foods store setup", () => {
  const target = {
    store,
    productUrl: "https://www.wholefoodsmarket.com/grocery/product/x-b0096m5pbw",
    timeoutMs: 30_000,
  };

  it("reports whether the store had to be changed", async () => {
    const browser = { round: vi.fn(async () => ({ shown: "10259", changed: false })) };
    expect(await ensureWholeFoodsStore(browser, target, signal())).toEqual({ changed: false });
    expect(browser.round).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        storeId: store.storeId,
        cookie: wholeFoodsStoreCookie(store),
        productUrl: target.productUrl,
      }),
      expect.anything(),
    );
  });

  it("names a store that could not be set by the round's own code", async () => {
    const failure = { name: "Error", code: "WHOLEFOODS.STORE_NOT_SET" };
    const browser = {
      round: vi.fn(async () =>
        Promise.reject(egoErrors.create("BROWSER.UNAVAILABLE", { details: { failure } })),
      ),
    };
    await expect(ensureWholeFoodsStore(browser, target, signal())).rejects.toMatchObject({
      code: "WHOLEFOODS.STORE_NOT_SET",
    });
  });

  it("passes any other browser failure on unchanged", async () => {
    const browser = {
      round: vi.fn(async () => Promise.reject(egoErrors.create("BROWSER.USER_CONTROL"))),
    };
    await expect(ensureWholeFoodsStore(browser, target, signal())).rejects.toMatchObject({
      code: "BROWSER.USER_CONTROL",
    });
  });

  it("is a valid round script for the Ego runtime", async () => {
    let body = "";
    const browser = {
      round: vi.fn(async (script: string) => {
        body = script;
        return { shown: "The Alameda", changed: true };
      }),
    };
    await ensureWholeFoodsStore(browser, target, signal());
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
    expect(() => new AsyncFunction(pageRoundScript(body, { taskSpaceId: 1 }))).not.toThrow();
  });
});

it("records a fully scrolled no-results brand as not sold at this store", async () => {
  const { scanner, browser } = scanSetup(fixture("search-no-results.html"));
  expect(await scanner.scan({ scanId: "empty-brand", sourceUrl }, signal())).toMatchObject({
    complete: true,
    soldHere: false,
    pages: [{ products: [], soldHere: false }],
  });
  expect(browser.read).toHaveBeenCalledWith(
    expect.objectContaining({ readySelector: "main" }),
    expect.anything(),
  );
});
