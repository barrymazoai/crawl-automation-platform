import type { ObjectStore, ScraperApiPage, ScraperApiRequest } from "@crawl-automation/platform";
import { scraperApiErrors } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { ListingPages, type ListingPageRequest } from "./listing-pages.js";

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

const ORIGIN = "https://www.swansonvitamins.com";
const request: ListingPageRequest = {
  scanId: "11111111-1111-4111-8111-111111111111",
  channel: "swanson",
  url: `${ORIGIN}/collections/brand-now-foods/products.json?limit=250&page=1`,
  label: "page-1",
  answer: "json",
  origins: [ORIGIN],
  maxBytes: 100_000,
};
const settings = {
  routeId: "scraperapi-us",
  egressId: "scraperapi-us/1",
  defaults: { countryCode: "us", sessionNumber: null, render: false, premium: false },
  channels: { swanson: { premium: true } },
};

function setup(page: Partial<ScraperApiPage> = {}) {
  const remote = new MemoryStore();
  const get = vi.fn(async (asked: ScraperApiRequest): Promise<ScraperApiPage> => ({
    status: 200,
    url: asked.target,
    contentType: "application/json; charset=utf-8",
    contentEncoding: null,
    bytes: Buffer.from('{"products":[]}'),
    creditCost: 1,
    ...page,
  }));
  const pages = new ListingPages({
    client: { provider: "scraperapi-sync/1", get },
    settings,
    remote,
  });
  return { remote, get, pages };
}

const signal = () => new AbortController().signal;
const prefix = `v3/brand-scans/${request.scanId}/page-1`;

describe("listing pages through ScraperAPI", () => {
  it("preserves challenge evidence as the existing brand-scan challenge code, with no retry", async () => {
    const { pages, get, remote } = setup();
    const details = { location: `${request.url}&__shopify_bv_challenge=token` };
    get.mockRejectedValueOnce(scraperApiErrors.create("SOURCE.ACCESS_CHALLENGE", { details }));
    await expect(pages.read(request, signal())).rejects.toMatchObject({
      code: "BRAND_SCAN.ACCESS_CHALLENGE",
      details,
    });
    expect(get).toHaveBeenCalledOnce();
    expect(remote.data.size).toBe(0);
  });

  it("archives the page and its record before it is read, with the channel's own options", async () => {
    const { remote, get, pages } = setup();
    const read = await pages.read(request, signal());
    expect(read).toMatchObject({
      body: '{"products":[]}',
      archiveKey: `${prefix}.json`,
      creditCost: 1,
      fromArchive: false,
    });
    expect(get.mock.calls[0]?.[0].options).toMatchObject({ premium: true, countryCode: "us" });
    expect(remote.data.has(`${prefix}.record.json`)).toBe(true);
  });

  it("reads an archived page from the archive and never pays for it again", async () => {
    const { get, pages } = setup();
    await pages.read(request, signal());
    expect(await pages.read(request, signal())).toMatchObject({
      fromArchive: true,
      creditCost: null,
    });
    expect(get).toHaveBeenCalledOnce();
  });

  it("keeps resolution HTML and cross-origin JSON in separate verified archives", async () => {
    const { get, pages, remote } = setup();
    const origins = [ORIGIN, "https://ac.cnstrc.com"];
    const resolve = {
      ...request,
      origins,
      label: "resolve",
      answer: "html" as const,
      url: `${ORIGIN}/collections/brand-example`,
    };
    const api = { ...request, origins, url: "https://ac.cnstrc.com/browse/brand/Example" };
    get.mockResolvedValueOnce({
      status: 200,
      url: resolve.url,
      contentType: "text/html",
      contentEncoding: null,
      bytes: Buffer.from('<constructor-plp data-collection-title="Example" />'),
      creditCost: 1,
    });
    for (const target of [resolve, api]) {
      const first = await pages.read(target, signal());
      expect(remote.data.get(first.archiveKey)).toEqual(Buffer.from(first.body));
      const second = await pages.read(target, signal());
      expect(second).toMatchObject({ body: first.body, fromArchive: true, creditCost: null });
    }
    expect(get).toHaveBeenCalledTimes(2);
    expect(remote.data.size).toBe(4);
  });

  it("stops on a page body whose record was never written, rather than fetching it again", async () => {
    const { remote, get, pages } = setup();
    remote.data.set(`${prefix}.json`, Buffer.from("{}"));
    await expect(pages.read(request, signal())).rejects.toMatchObject({
      code: "BRAND_SCAN.ARCHIVE_UNVERIFIED",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 404 }, "BRAND_SCAN.NOT_FOUND"],
    [{ contentType: "text/html" }, "BRAND_SCAN.NOT_JSON"],
    [{ contentEncoding: "gzip" }, "BRAND_SCAN.ENCODING"],
  ])("refuses an answer it cannot read (%o), archiving nothing", async (page, code) => {
    const { remote, pages } = setup(page);
    await expect(pages.read(request, signal())).rejects.toMatchObject({ code });
    expect(remote.data.size).toBe(0);
  });
});
