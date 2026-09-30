import { readFileSync } from "node:fs";
import {
  BrowserPages,
  BrowserProductCapture,
  ChannelRegistry,
  HttpCapture,
} from "@crawl-automation/channels-core";
import type { BrowserPage, ObjectStore } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
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
  const read = vi.fn(async (): Promise<BrowserPage> => ({
    html,
    url: landedUrl,
    status,
    ready: true,
    scroll: { rounds: 0, ended: "none" },
  }));
  const browser = { provider: "saved-page", read };
  const pages = new BrowserPages(browser, {
    routeId: "test",
    egressId: "test",
    channels: { wholefoods: { readySelector: "h1", storeId: store.storeId } },
  });
  const adapter = wholeFoodsAdapter(store);
  const publish = async (key: string, bytes: Uint8Array) => {
    await remote.create(key, bytes, "text/html", signal());
  };
  const capture = new BrowserProductCapture({
    registry: new ChannelRegistry([adapter]),
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
    const first = await capture.capture(request, signal());
    expect(first).toMatchObject({ status: "captured", listingId: "B002CQU54Q" });
    expect(data.get("v3/wholefoods-html/wholefoods-capture/original.html")).toEqual(
      Buffer.from(html),
    );
    expect(await capture.capture(request, signal())).toEqual(first);
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    ["/grocery/product/fish-oil-b0096m5pbw", "redirected_to_other_product", "B0096M5PBW"],
    ["/grocery/search?k=fish", "redirected_away", null],
  ])("still classifies a redirect to %s", async (path, reason, observedListingId) => {
    const finalUrl = new URL(path, url).href;
    const { capture, adapter, data } = setup(finalUrl);
    const parse = vi.spyOn(adapter, "parseProduct");
    expect(await capture.capture(request, signal())).toMatchObject({
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
    expect(await capture.capture(request, signal())).toMatchObject({
      status: "sighted",
      sighting: { state: "unlisted", reason: "not_found", httpStatus: status },
    });
  });
});
