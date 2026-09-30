import { describe, expect, it, vi } from "vitest";
import { RetainedPublication, type ObjectStore } from "@crawl-automation/platform";
import type { BrowserRead, BrowserPage } from "@crawl-automation/platform";
import { DtcCatalogPages } from "./catalog-pages.js";
import { dtcSitePolicy } from "./site-policy.js";

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
  platform: "shopify",
  catalogUrl: "https://shop.example/collections/all",
});
const request = { site, url: site.catalogUrl ?? "", scanId: "scan-archive", position: 1 };
const signal = () => AbortSignal.timeout(5000);
function setup() {
  const remote = new Memory();
  const publication = new RetainedPublication(new Memory(), remote);
  const read = vi.fn(async (request: BrowserRead): Promise<BrowserPage> => ({
    url: request.url,
    html: '<main><div id="product-grid">é 🧪</div></main>',
    status: 200,
    ready: true,
    scroll: { rounds: 3, ended: "stable" },
  }));
  const pages = new DtcCatalogPages({ browser: { read, provider: "ego-lite/2" }, publication });
  return { remote, read, pages };
}

describe("DTC catalog retained browser evidence", () => {
  it("archives bytes and scroll proof before returning and reuses them", async () => {
    const { pages, read, remote } = setup();
    const result = await pages.read(request, signal());
    expect(Buffer.from(remote.data.get(result.archiveKey) ?? []).toString()).toBe(result.html);
    expect(await pages.read(request, signal())).toEqual(result);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0].scroll).toEqual(site.scroll);
  });
  it("does not refetch when original HTML exists but scroll proof is missing", async () => {
    const { pages, read, remote } = setup();
    const result = await pages.read(request, signal());
    remote.data.delete(result.archiveKey.replace("original.html", "catalog-proof.json"));
    await expect(pages.read(request, signal())).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("does not retry a failed browser read", async () => {
    const { pages, read } = setup();
    read.mockRejectedValueOnce(new Error("browser stopped"));
    await expect(pages.read(request, signal())).rejects.toThrow();
    await expect(pages.read(request, signal())).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("rejects a changed original on reuse", async () => {
    const { pages, remote } = setup();
    const result = await pages.read(request, signal());
    remote.data.set(result.archiveKey, Buffer.from("changed"));
    await expect(pages.read(request, signal())).rejects.toThrow();
  });
  it("refuses an unready browser read", async () => {
    const { pages, read } = setup();
    read.mockResolvedValueOnce({
      url: request.url,
      html: "<main>loading</main>",
      status: 200,
      ready: false,
      scroll: { rounds: 0, ended: "none" },
    });
    await expect(pages.read(request, signal())).rejects.toThrow();
  });
});
