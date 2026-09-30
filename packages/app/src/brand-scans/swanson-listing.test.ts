import { createSwansonAdapter } from "@crawl-automation/channel-swanson";
import { setTimeout } from "node:timers/promises";
import { ChannelRegistry, type ListingPageRequest } from "@crawl-automation/channels-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readListing } from "./scan-listing.js";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => undefined) }));
beforeEach(() => vi.mocked(setTimeout).mockClear());

const origin = "https://www.swansonvitamins.com";
const scan = {
  scanId: "scan",
  source: { sourceId: "source", channel: "swanson", url: `${origin}/collections/brand-test` },
};
const collection = '<main><constructor-plp data-collection-title="Test &amp; Brand" /></main>';
const response = (handles: string[], total: number) =>
  JSON.stringify({
    response: {
      total_num_results: total,
      results: handles.map((handle) => ({
        value: "Product",
        data: { id: handle, url: handle },
        variations: [{ data: { url: "large" } }, { data: { url: handle } }],
      })),
    },
  });

function fixture(bodies: Record<string, string>, configured = true) {
  const read = vi.fn(async (request: ListingPageRequest) => ({
    body: bodies[request.label] ?? "",
    archiveKey: request.label,
    creditCost: 1,
    fromArchive: false,
  }));
  const adapter = createSwansonAdapter(configured ? { constructorKey: "test-key" } : undefined);
  const readers = { registry: new ChannelRegistry([adapter]), pages: { read }, browsers: {} };
  return {
    read,
    run: (requestIntervalMs = 0) =>
      readListing(
        { ...readers, channels: { swanson: { requestIntervalMs } } },
        scan,
        new AbortController().signal,
      ),
  };
}

describe("two-stage archived Swanson listing", () => {
  it("resolves HTML then pages JSON to the card total, deduping products across pages", async () => {
    const handles = Array.from({ length: 100 }, (_, index) => `item-${index}`);
    const test = fixture({
      resolve: collection,
      "page-1": response(handles, 101),
      "page-2": response(["last"], 101),
    });
    const listing = await test.run(3000);
    expect(setTimeout).toHaveBeenCalledTimes(2);
    expect(setTimeout).toHaveBeenCalledWith(3000, undefined, { signal: expect.any(AbortSignal) });
    expect(listing).toMatchObject({ full: true, credits: 3, families: 0, unresolvedFamilies: 0 });
    expect(listing.pages).toHaveLength(2);
    expect(listing.products).toHaveLength(102);
    expect(test.read.mock.calls.map(([request]) => [request.label, request.answer])).toEqual([
      ["resolve", "html"],
      ["page-1", "json"],
      ["page-2", "json"],
    ]);
    expect(test.read.mock.calls[0]?.[0].url).toBe(scan.source.url);
    const api = new URL(test.read.mock.calls[2]?.[0].url ?? "");
    expect(api.pathname).toBe("/browse/brand/Test%20%26%20Brand");
    expect(api.searchParams.get("page")).toBe("2");
    expect(test.read.mock.calls[1]?.[0].origins).toContain("https://ac.cnstrc.com");
  });

  it("leaves an exhausted but incomplete API listing partial", async () => {
    const test = fixture({ resolve: collection, "page-1": response(["small"], 2) });
    expect(await test.run()).toMatchObject({ full: false, families: 0, credits: 2 });
    expect(test.read).toHaveBeenCalledTimes(2);
  });

  it("stops on empty API pages while retaining the incomplete total", async () => {
    const test = fixture({ resolve: collection, "page-1": response([], 101) });
    expect(await test.run()).toMatchObject({ full: false, products: [] });
    expect(test.read).toHaveBeenCalledTimes(2);
  });

  it("refuses missing configuration before any paid read", async () => {
    const test = fixture({}, false);
    await expect(test.run()).rejects.toMatchObject({ code: "SWANSON.CONSTRUCTOR_KEY_MISSING" });
    expect(test.read).not.toHaveBeenCalled();
  });

  it("never requests JSON when the collection cannot resolve a title", async () => {
    const test = fixture({ resolve: "<main><constructor-plp /></main>" });
    await expect(test.run()).rejects.toMatchObject({ code: "SWANSON.COLLECTION_TITLE_MISSING" });
    expect(test.read).toHaveBeenCalledTimes(1);
  });
});
