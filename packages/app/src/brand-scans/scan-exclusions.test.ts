import { ChannelRegistry, type ListedProduct } from "@crawl-automation/channels-core";
import { Writable } from "node:stream";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import type { AddProducts, AddToQueue } from "../queue/queue-model.js";
import { BrandScanRunner } from "./brand-scan-runner.js";
import type { BrandScanStore } from "./ports.js";
import type { ScanRecord, ScanResult } from "./scan-model.js";

const ORIGIN = "https://shop.example";
const listed = (id: string, extra: Partial<ListedProduct> = {}): ListedProduct => ({
  url: `${ORIGIN}/products/${id}`,
  listingId: id,
  variantId: null,
  title: null,
  kind: "product",
  ...extra,
});
const scan: ScanRecord = {
  scanId: "5f7a3c9e-6f0b-4c1e-9a3b-111111111111",
  requestId: "5f7a3c9e-6f0b-4c1e-9a3b-222222222222",
  source: {
    sourceId: "5f7a3c9e-6f0b-4c1e-9a3b-333333333333",
    brandId: "5f7a3c9e-6f0b-4c1e-9a3b-444444444444",
    brandName: "DMoose",
    channel: "wholefoods",
    url: `${ORIGIN}/collections/all`,
    enabled: true,
  },
  revisitBatchId: "5f7a3c9e-6f0b-4c1e-9a3b-555555555555",
  state: "running",
  result: null,
  requestedAt: "2026-10-28T00:00:00.000Z",
  startedAt: "2026-10-28T00:00:01.000Z",
  finishedAt: null,
};

describe("products the scan judged outside supplements", () => {
  it("are listed but never queued, and never revisited as missing", async () => {
    const exclusion = {
      basis: "model" as const,
      reason: "a weightlifting belt",
      evidenceKey: "v3/x",
    };
    const belt = { url: `${ORIGIN}/products/belt?size=l`, title: "Lifting Belt - L" };
    const pages = [
      { products: [listed("whey"), listed("belt", { ...belt, excluded: exclusion })], cards: 2 },
    ];
    const finished: ScanResult[] = [];
    const lists: AddProducts[] = [];
    const store = {
      isCancellationRequested: vi.fn(async () => false),
      claim: vi.fn(async () => [scan]),
      finish: vi.fn(async (_id: string, result: ScanResult) => void finished.push(result)),
      knownListings: vi.fn(async () => [
        { sourceId: scan.source.sourceId, url: belt.url, listingId: "belt", variantId: null },
      ]),
    } as unknown as BrandScanStore;
    const listings = { requestRevisits: vi.fn(async () => ({ queued: 1 })) };
    const browser = {
      sourceUrl: (url: string) => url,
      scan: vi.fn(async () => ({
        pages: pages.map((page) => ({ ...page, nextPage: null, statedTotal: null })),
        complete: true,
        soldHere: true,
        archiveKeys: [],
      })),
    };
    const runner = new BrandScanRunner({
      store,
      pages: { read: vi.fn() },
      registry: new ChannelRegistry([]),
      browsers: { wholefoods: browser },
      queue: {
        add: vi.fn(async (list: AddToQueue) => {
          lists.push(list as AddProducts);
          return { added: 1, following: 0, recent: 0 };
        }),
      },
      listings,
      log: createLogger({
        name: "test",
        destination: new Writable({ write: (_c, _e, done) => done() }),
      }),
    });
    await runner.tick(new AbortController().signal);
    expect(lists[0]?.products.map((item) => item.listingId)).toEqual(["whey"]);
    expect(listings.requestRevisits).not.toHaveBeenCalled();
    expect(finished[0]?.excluded).toEqual({
      products: 1,
      variants: 1,
      items: [
        { listingId: "belt", url: `${ORIGIN}/products/belt`, title: belt.title, ...exclusion },
      ],
    });
  });
});
