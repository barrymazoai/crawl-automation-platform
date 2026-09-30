import { describe, expect, it, vi } from "vitest";
import { AmazonStoreArchive } from "./store-archive.js";
import { AmazonStoreBrandScan } from "./store-scan.js";
import type { StoreDraw } from "./store-scroll.js";
import {
  asinOne,
  asinTwo,
  drawPage,
  storeHome,
  storeShop,
  storeHtml,
  storePublication,
} from "./testing/store-fakes.js";

const signal = () => new AbortController().signal;
const request = { scanId: "store-scan", sourceUrl: storeHome };

function scannerFor(draws: Map<string, StoreDraw>) {
  const stores = storePublication();
  const pages = {
    read: vi.fn(async (url: string) => {
      const draw = draws.get(url);
      if (!draw) {
        throw new Error(`Unexpected sub-page: ${url}`);
      }
      return draw;
    }),
  };
  return {
    ...stores,
    pages,
    scanner: new AmazonStoreBrandScan({ pages, publication: stores.publication }),
  };
}

describe("Amazon Store navigation scan", () => {
  it("walks all observed sub-pages, removes tracking aliases and deduplicates across pages", async () => {
    const draws = new Map([
      [storeHome, drawPage({ html: storeHtml([asinOne], [storeHome, storeShop + "?ref_=nav"]) })],
      [
        storeShop,
        drawPage({ url: storeShop, html: storeHtml([asinOne, asinTwo], [storeHome, storeShop]) }),
      ],
    ]);
    const setup = scannerFor(draws);
    const result = await setup.scanner.scan(request, signal());
    expect(setup.pages.read.mock.calls.map(([url]) => url)).toEqual([storeHome, storeShop]);
    expect(
      result.pages.flatMap((page) => page.products.map((product) => product.listingId)),
    ).toEqual([asinOne, asinTwo]);
    expect(result.complete).toBe(true);
    expect(result.archiveKeys).toHaveLength(2);
    expect(result.proofs.every(({ scroll }) => scroll.ended === "stable")).toBe(true);
    for (const key of result.archiveKeys) {
      expect(setup.remote.data.get(key)).toEqual(setup.local.data.get(key));
    }
    await setup.scanner.scan(request, signal());
    expect(setup.pages.read).toHaveBeenCalledTimes(2);
  });

  it("retains and parses virtualized tiles from earlier raw snapshots", async () => {
    const draw = drawPage();
    draw.snapshots.push(...drawPage({ html: storeHtml([asinTwo]) }).snapshots);
    const setup = scannerFor(new Map([[storeHome, draw]]));
    const result = await setup.scanner.scan(request, signal());
    expect(result.pages[0]?.products.map((product) => product.listingId)).toEqual([
      asinOne,
      asinTwo,
    ]);
  });

  it.each(["capped", "unverified"] as const)(
    "keeps the whole scan partial if one page is %s",
    async (ended) => {
      const home = drawPage({ html: storeHtml([asinOne], [storeHome, storeShop]) });
      const shop = drawPage({ url: storeShop });
      shop.proof.ended = ended;
      const setup = scannerFor(
        new Map([
          [storeHome, home],
          [storeShop, shop],
        ]),
      );
      expect((await setup.scanner.scan(request, signal())).complete).toBe(false);
    },
  );

  it("cannot claim full from a forged stable label without the actual stop conditions", async () => {
    const draw = drawPage();
    draw.proof.stableRounds = 0;
    const setup = scannerFor(new Map([[storeHome, draw]]));
    expect((await setup.scanner.scan(request, signal())).complete).toBe(false);
  });

  it("stops at 100 sub-pages with a partial result", async () => {
    const draws = new Map<string, StoreDraw>();
    const urls = Array.from(
      { length: 101 },
      (_, index) => storeHome.slice(0, -12) + String(index + 1).padStart(12, "0"),
    );
    urls.forEach((url) => draws.set(url, drawPage({ url, html: storeHtml([asinOne], urls) })));
    const setup = scannerFor(draws);
    const result = await setup.scanner.scan(request, signal());
    expect(result.complete).toBe(false);
    expect(setup.pages.read).toHaveBeenCalledTimes(100);
  });

  it.each([
    ["redirect", { url: storeShop }, "AMAZON.STORE_REDIRECT"],
    ["HTTP failure", { status: 503 }, "BRAND_SCAN.HTTP_STATUS"],
    [
      "missing navigation",
      { html: "<html><body>Loading</body></html>" },
      "AMAZON.STORE_UNVERIFIED",
    ],
  ])("archives before rejecting %s", async (_label, overrides, code) => {
    const setup = scannerFor(new Map([[storeHome, drawPage(overrides)]]));
    await expect(setup.scanner.scan(request, signal())).rejects.toMatchObject({ code });
    expect(
      [...setup.remote.data.keys()].filter((key) => key.includes("/store-scan/store-")),
    ).toHaveLength(1);
    await expect(setup.scanner.scan(request, signal())).rejects.toMatchObject({ code });
    expect(setup.pages.read).toHaveBeenCalledOnce();
  });

  it("starts no page for an already cancelled scan", async () => {
    const setup = scannerFor(new Map());
    await expect(setup.scanner.scan(request, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(setup.pages.read).not.toHaveBeenCalled();
  });
});

describe("Store original evidence", () => {
  it("refuses changed bytes, hash, length or source without opening a page", async () => {
    const setup = scannerFor(new Map([[storeHome, drawPage()]]));
    const result = await setup.scanner.scan(request, signal());
    const key = result.archiveKeys[0] ?? "";
    const original = JSON.parse(Buffer.from(setup.remote.data.get(key) ?? []).toString());
    for (const mutate of [
      () => ({ ...original, sourceUrl: storeShop }),
      () => ({ ...original, originals: [{ sha256: "bad", byteSize: 1 }] }),
      () => ({ ...original, draw: { ...original.draw, snapshots: [] } }),
    ]) {
      setup.remote.data.set(key, Buffer.from(JSON.stringify(mutate())));
      await expect(setup.scanner.scan(request, signal())).rejects.toMatchObject({
        code: "BRAND_SCAN.ARCHIVE_UNVERIFIED",
      });
    }
    expect(setup.pages.read).toHaveBeenCalledOnce();
  });

  it("publishes a retained local original before reuse, without redrawing", async () => {
    const setup = scannerFor(new Map([[storeHome, drawPage()]]));
    const archive = new AmazonStoreArchive(setup.publication, {
      scanId: request.scanId,
      url: storeHome,
    });
    await archive.save(drawPage(), signal());
    const fresh = storePublication();
    fresh.local.data.set(archive.key, setup.local.data.get(archive.key) ?? new Uint8Array());
    const scanner = new AmazonStoreBrandScan({
      pages: setup.pages,
      publication: fresh.publication,
    });
    expect((await scanner.scan(request, signal())).complete).toBe(true);
    expect(setup.pages.read).not.toHaveBeenCalled();
    expect(fresh.remote.data.get(archive.key)).toEqual(fresh.local.data.get(archive.key));
  });

  it("stops on unknown publication and retains the local raw original", async () => {
    const setup = scannerFor(new Map([[storeHome, drawPage()]]));
    vi.spyOn(setup.remote, "create").mockRejectedValue(new Error("storage unavailable"));
    await expect(setup.scanner.scan(request, signal())).rejects.toMatchObject({
      code: "ARTIFACT.UPLOAD_UNKNOWN",
    });
    expect([...setup.local.data.keys()].some((key) => key.includes("/store-scan/store-"))).toBe(
      true,
    );
    expect(setup.pages.read).toHaveBeenCalledOnce();
  });
});
