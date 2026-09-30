import { describe, expect, it, vi } from "vitest";
import { BrowserPages, HttpCapture, OriginalHtmlArchive } from "@crawl-automation/channels-core";
import { RetainedPublication, type ObjectStore } from "@crawl-automation/platform";
import { createDtcAdapter } from "./adapter.js";
import { DTC_BROWSER_POLICY, dtcSitePolicy } from "./site-policy.js";

class Memory implements ObjectStore {
  data = new Map<string, Uint8Array>();
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

const site = dtcSitePolicy({
  siteKey: "shop.example",
  platform: "jsonld",
  catalogUrl: "https://shop.example/collections/all",
});
const adapter = createDtcAdapter([site]);
const url = "https://shop.example/products/sleep";
const address = adapter.productAddress(url);
const original = `<html><head><link rel="canonical" href="${url}"></head><body><main><h1>Sleep</h1>
<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Sleep", sku: "123", url, offers: { price: "12.50", priceCurrency: "USD" } })}</script></main></body></html>`;

function setup(html = original) {
  const remote = new Memory();
  const publication = new RetainedPublication(new Memory(), remote);
  const archive = new OriginalHtmlArchive(publication, {
    channel: "dtc",
    maxBytes: 10000,
    capture: {
      ...address,
      operationId: "capture-dtc",
      sessionId: "capture-dtc",
      sourceId: "dtc-source",
    },
  });
  const read = vi.fn(async () => ({
    url,
    html,
    status: 200,
    ready: true,
    scroll: { rounds: 0, ended: "none" as const },
  }));
  const pages = new BrowserPages(
    { provider: "ego-lite/2", read },
    { routeId: "ego-test", egressId: "test", channels: { dtc: DTC_BROWSER_POLICY } },
  );
  return { remote, archive, read, capture: new HttpCapture(pages) };
}

describe("DTC through shared BrowserPages (in-memory browser double)", () => {
  it("archives first, parses the product, and reuses original bytes", async () => {
    const { remote, archive, read, capture } = setup();
    const result = await capture.capture(adapter, archive, AbortSignal.timeout(5000));
    expect(result.status).toBe("page");
    if (result.status === "page") {
      expect(result.parsed.commerce?.price).toBe("12.50");
      expect(Buffer.from(remote.data.get(result.archiveKey) ?? []).toString()).toBe(original);
    }
    await capture.capture(adapter, archive, AbortSignal.timeout(5000));
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("lets core classify a wrong canonical page as identity_conflict", async () => {
    const { capture, archive } = setup(
      '<link rel="canonical" href="https://shop.example/products/other">',
    );
    const result = await capture.capture(adapter, archive, AbortSignal.timeout(5000));
    expect(result).toMatchObject({ status: "sighting", sighting: { reason: "identity_conflict" } });
  });
});
