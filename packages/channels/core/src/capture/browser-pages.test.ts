import type { BrowserPage, BrowserRead } from "@crawl-automation/platform";
import { RetainedPublication, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { describe, expect, it, vi } from "vitest";
import type { ChannelAdapter } from "../adapter.js";
import { BrowserPages, type BrowserCaptureSettings } from "./browser-pages.js";
import { HttpCapture } from "./http-capture.js";
import { OriginalHtmlArchive } from "./original-html-archive.js";
import { ScraperApiPages } from "./page-fetch.js";

const ORIGIN = "https://www.wholefoodsmarket.com";
const url = `${ORIGIN}/grocery/product/omega-b0096m5pbw`;
const policy = { origins: [ORIGIN], maxBytes: 10_000, timeoutMs: 5_000 };
const signal = () => AbortSignal.timeout(5_000);
const settings: BrowserCaptureSettings = {
  routeId: "ego-server2",
  egressId: "ego-server2/space-1",
  channels: { wholefoods: { readySelector: "h1", storeId: "10259" } },
};

class Memory implements ObjectStore {
  readonly data = new Map<string, Uint8Array>();
  read = vi.fn(async (key: string) => this.data.get(key) ?? null);
  create = vi.fn(async (key: string, bytes: Uint8Array) => {
    if (this.data.has(key)) {
      return "exists" as const;
    }
    this.data.set(key, Buffer.from(bytes));
    return "created" as const;
  });
}

/** A browser that draws one page and records what it was asked to read. */
function browser(page: Partial<BrowserPage> = {}) {
  const read = vi.fn(async (request: BrowserRead): Promise<BrowserPage> => ({
    url: request.url,
    status: 200,
    html: "<html><body><h1>Omega</h1></body></html>",
    ready: true,
    scroll: { rounds: 0, ended: "none" },
    ...page,
  }));
  return { provider: "ego-lite/2", read };
}

const adapter: ChannelAdapter = {
  id: "wholefoods",
  captureModes: ["browser"],
  httpPolicy: policy,
  productAddress: (address) => ({ url: address, listingId: "B0096M5PBW", variantId: null }),
  parseProduct: (page) =>
    ({ html: page.html, identity: { listingId: "B0096M5PBW", variantId: null } }) as never,
};
const capture = {
  operationId: "wf-op",
  sessionId: "wf-op",
  url,
  sourceId: "source",
  listingId: "B0096M5PBW",
  variantId: null,
};

function archive(remote = new Memory()) {
  const publication = new RetainedPublication(new Memory(), remote);
  return new OriginalHtmlArchive(publication, {
    channel: "wholefoods",
    capture,
    maxBytes: policy.maxBytes,
  });
}

describe("BrowserPages", () => {
  it("records page-owned identity conflicts before parsing and only after archiving the page", async () => {
    const remote = new Memory();
    const drawn = browser();
    const parseProduct = vi.fn();
    const other = { listingId: "B000000001", variantId: null };
    const pageIdentity = vi.fn(() => {
      expect(remote.data.has("v3/wholefoods-html/wf-op/original.json")).toBe(true);
      return other;
    });
    const capturer = new HttpCapture(new BrowserPages(drawn, settings));
    const result = await capturer.capture(
      { ...adapter, pageIdentity, parseProduct },
      archive(remote),
      signal(),
    );
    expect(result).toMatchObject({
      status: "sighting",
      sighting: {
        state: "unlisted",
        reason: "identity_conflict",
        causeCode: "LISTING.IDENTITY_CONFLICT",
        observedListingId: other.listingId,
        archiveKey: "v3/wholefoods-html/wf-op/original.html",
      },
    });
    const receipt = JSON.parse(
      Buffer.from(remote.data.get("v3/wholefoods-html/wf-op/original.json") ?? []).toString(),
    );
    expect(receipt.capture.listingId).toBe("B0096M5PBW");
    expect(parseProduct).not.toHaveBeenCalled();
  });

  it("draws the page once, archives it with its store, then reads only the archive", async () => {
    const remote = new Memory();
    const drawn = browser();
    const capturer = new HttpCapture(new BrowserPages(drawn, settings));
    const first = await capturer.capture(adapter, archive(remote), signal());
    await capturer.capture(adapter, archive(remote), signal());
    expect(drawn.read).toHaveBeenCalledOnce();
    expect(drawn.read).toHaveBeenCalledWith(
      expect.objectContaining({ url, readySelector: "h1" }),
      expect.anything(),
    );
    expect(first).toMatchObject({
      status: "page",
      archiveKey: "v3/wholefoods-html/wf-op/original.html",
    });
    const receipt = JSON.parse(
      Buffer.from(remote.data.get("v3/wholefoods-html/wf-op/original.json") ?? []).toString(),
    );
    expect(receipt.fetchedVia).toEqual({
      mode: "browser",
      routeId: "ego-server2",
      egressId: "ego-server2/space-1",
      provider: "ego-lite/2",
      storeId: "10259",
    });
  });

  it("reports a page that no longer exists as unlisted, like any other capture", async () => {
    const capturer = new HttpCapture(new BrowserPages(browser({ status: 404 }), settings));
    expect(await capturer.capture(adapter, archive(), signal())).toMatchObject({
      status: "sighting",
      sighting: { state: "unlisted" },
    });
  });

  it("is refused for a channel not configured for the browser", async () => {
    const drawn = browser();
    const pages = new BrowserPages(drawn, { ...settings, channels: {} });
    await expect(
      pages.fetchPage({ channel: "wholefoods", url, policy }, signal()),
    ).rejects.toMatchObject({
      code: "CHANNEL.CAPTURE_MODE_UNSUPPORTED",
    });
    expect(drawn.read).not.toHaveBeenCalled();
  });

  it("never lets ScraperAPI capture a browser-only channel", async () => {
    const client = { provider: "scraperapi-sync/1" as const, get: vi.fn() };
    const defaults = { countryCode: "us", sessionNumber: null, render: false, premium: false };
    const http = new ScraperApiPages(client, {
      routeId: "r",
      egressId: "e",
      defaults,
      channels: {},
    });
    await expect(new HttpCapture(http).capture(adapter, archive(), signal())).rejects.toMatchObject(
      {
        code: "CHANNEL.CAPTURE_MODE_UNSUPPORTED",
        details: { mode: "http" },
      },
    );
    expect(client.get).not.toHaveBeenCalled();
  });
});
