import { readFileSync } from "node:fs";
import {
  ProductCapture,
  ScraperApiPages,
  ProductSourcePlans,
  ChannelRegistry,
  HttpCapture,
} from "@crawl-automation/channels-core";
import type { ScraperApiPage, ObjectStore } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { WHOLE_FOODS_HTTP_OPTIONS } from "./whole-foods-http.js";
import { wholeFoodsAdapter } from "./whole-foods-adapter.js";

// Existing synthetic page; real Whole Foods identity evidence is still ticket R22.
const html = readFileSync(new URL("./fixtures/product-b0096m5pbw.html", import.meta.url), "utf8");
const url = "https://www.wholefoodsmarket.com/grocery/product/other-product-b002cqu54q";
const store = { storeId: "10259", label: "The Alameda", postalCode: "95126" };
const request = {
  runId: "wholefoods-run",
  operationId: "wholefoods-capture",
  sourceId: "source",
  brandId: "brand",
  channel: "wholefoods" as const,
  url,
};
const signal = () => AbortSignal.timeout(5_000);

function setup(landedUrl = url, status = 200) {
  const data = new Map<string, Uint8Array>();
  const remote: ObjectStore = {
    read: async (key) => data.get(key) ?? null,
    create: async (key, bytes) => {
      if (data.has(key)) {
        return "exists";
      }
      data.set(key, Buffer.from(bytes));
      return "created";
    },
  };
  const read = vi.fn(async (): Promise<ScraperApiPage> => ({
    bytes: Buffer.from(html),
    url: landedUrl,
    status,
    contentType: "text/html",
    contentEncoding: null,
    creditCost: 1,
  }));
  const pages = new ScraperApiPages(
    { provider: "scraperapi-sync/1", get: read },
    {
      routeId: "test",
      egressId: "test",
      defaults: { countryCode: "us", sessionNumber: null, render: false, premium: false },
      channels: { wholefoods: WHOLE_FOODS_HTTP_OPTIONS },
    },
  );
  const adapter = wholeFoodsAdapter(store);
  const publish = async (key: string, bytes: Uint8Array) => {
    await remote.create(key, bytes, "text/html", signal());
  };
  const capture = new ProductCapture({
    registry: new ChannelRegistry([adapter]),
    sourcePlans: { publish: vi.fn() } as unknown as ProductSourcePlans,
    http: new HttpCapture(pages),
    publication: { local: remote, remote, retain: publish, publish },
  });
  return { adapter, capture, data, read };
}

describe("Whole Foods capture with page identity unknown (R22)", () => {
  it("does not infer a conflict from a different requested ASIN or invent metadata", async () => {
    const { adapter, capture, data, read } = setup();
    expect(
      adapter.pageIdentity?.({ url, html, capturedAt: "2026-09-30T08:00:00.000Z" }),
    ).toBeNull();
    const first = await capture.captureForAdapter(request, signal());
    expect(first).toMatchObject({ status: "captured-family", listingId: "B002CQU54Q" });
    expect(data.get("v3/wholefoods-html/wholefoods-capture/original.html")).toEqual(
      Buffer.from(html),
    );
    expect(await capture.captureForAdapter(request, signal())).toEqual(first);
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ headers: { cookie: "wfm_store_d8=10259" } }),
      }),
      expect.anything(),
    );
  });

  it.each([
    ["/grocery/product/fish-oil-b0096m5pbw", "redirected_to_other_product", "B0096M5PBW"],
    ["/grocery/search?k=fish", "redirected_away", null],
  ])("still classifies a redirect to %s", async (path, reason, observedListingId) => {
    const finalUrl = new URL(path, url).href;
    const { capture, adapter, data } = setup(finalUrl);
    const parse = vi.spyOn(adapter, "parseProduct");
    expect(await capture.captureForAdapter(request, signal())).toMatchObject({
      status: "sighted",
      listingId: "B002CQU54Q",
      sighting: { state: "unlisted", reason, observedListingId, finalUrl },
    });
    expect(parse).not.toHaveBeenCalled();
    expect(data.get("v3/wholefoods-html/wholefoods-capture/original.html")).toEqual(
      Buffer.from(html),
    );
  });

  it.each([404, 410])("classifies HTTP %s as not found", async (status) => {
    const { capture } = setup(url, status);
    expect(await capture.captureForAdapter(request, signal())).toMatchObject({
      status: "sighted",
      sighting: { state: "unlisted", reason: "not_found", httpStatus: status },
    });
  });
});
