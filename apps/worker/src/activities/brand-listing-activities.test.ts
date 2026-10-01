import { PostgresBrandScans } from "@crawl-automation/adapters";
import {
  ChannelRegistry,
  type BrandScanReader,
  type ChannelAdapter,
} from "@crawl-automation/channels-core";
import { setTimeout } from "node:timers/promises";
import * as channels from "@crawl-automation/channels-core";
import type { ListingPages } from "@crawl-automation/channels-core";
import type { WorkerParts } from "../container.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { brandListingActivities } from "./brand-listing-activities.js";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => undefined) }));
beforeEach(() => {
  vi.mocked(setTimeout).mockClear();
  vi.spyOn(PostgresBrandScans.prototype, "isCancellationRequested").mockResolvedValue(false);
});

vi.mock("./activity-guard.js", () => ({
  guarded:
    (_name: string, handler: (raw: unknown, signal: AbortSignal) => Promise<unknown>) =>
    (raw: unknown) =>
      handler(raw, new AbortController().signal),
}));
afterEach(() => vi.restoreAllMocks());

const request = {
  scanId: "11111111-1111-4111-8111-111111111111",
  source: {
    sourceId: "22222222-2222-4222-8222-222222222222",
    channel: "gnc",
    url: "https://example.com/brand",
    brandName: "Stored Brand",
  },
};
const page = { products: [], cards: 0, nextPage: null, statedTotal: 0 };

function fixture(capture: "http" | "browser", requestIntervalMs = 0) {
  const adapter = {
    id: "gnc",
    scanCapture: () => capture,
    httpPolicy: { origins: ["https://example.com"] },
    brandScan: {
      sourceUrl: (url: string) => url,
      pageUrl: (url: string) => url,
      answer: "json",
      maxBytes: 1000,
      maxPages: 10,
      parsePage: () => page,
      complete: () => true,
    },
  } as unknown as ChannelAdapter;
  const read = vi.fn(async () => ({ body: "{}", creditCost: 1 }));
  const factory = vi
    .spyOn(channels, "createListingPages")
    .mockReturnValue({ read } as unknown as ListingPages);
  const scan = vi.fn(async () => ({ pages: [page], complete: true, soldHere: true }));
  const parts = {
    registry: new ChannelRegistry([adapter]),
    config: { brandScans: { channels: { gnc: { requestIntervalMs } } } },
    r2: { store: {} },
    browser: { scanner: { scan } },
  } as unknown as WorkerParts;
  return {
    activity: brandListingActivities(parts).readBrandListing,
    parts,
    read,
    factory,
    scan,
    adapter,
  };
}

it("runs a configured HTTP listing through the shared archived reader", async () => {
  const test = fixture("http");
  await expect(test.activity(request)).resolves.toMatchObject({ full: true, credits: 1 });
  expect(test.factory).toHaveBeenCalledExactlyOnceWith(
    test.parts.config.brandScans,
    test.parts.r2.store,
  );
  expect(test.read).toHaveBeenCalledWith(
    expect.objectContaining({ scanId: request.scanId }),
    expect.any(AbortSignal),
  );
  expect(test.scan).not.toHaveBeenCalled();
});

it("selects browser capture by capability, regardless of channel name", async () => {
  const test = fixture("browser");
  await expect(test.activity(request)).resolves.toMatchObject({ full: true, credits: 0 });
  expect(test.scan).toHaveBeenCalledWith(
    {
      scanId: request.scanId,
      sourceId: request.source.sourceId,
      sourceUrl: request.source.url,
      checkpoint: expect.any(Function),
    },
    expect.any(AbortSignal),
  );
  expect(test.factory).not.toHaveBeenCalled();
});

it("refuses an HTTP listing without worker listing settings before a paid request", async () => {
  const test = fixture("http");
  delete test.parts.config.brandScans;
  await expect(test.activity(request)).rejects.toMatchObject({
    code: "WORKER.ROLE_SETTINGS_MISSING",
  });
  expect(test.read).not.toHaveBeenCalled();
});

it("passes the channel's configured interval to the activity's page loop", async () => {
  const test = fixture("http", 3000);
  const reader = test.adapter.brandScan;
  if (!reader) {
    throw new Error("fixture must have a listing reader");
  }
  reader.resolve = vi.fn<NonNullable<BrandScanReader["resolve"]>>(({ url }) => ({
    request: { url, label: "resolve", answer: "html", maxBytes: 1000 },
    parsePage: () => ({ sourceUrl: request.source.url }),
  }));
  await test.activity(request);
  expect(reader.resolve).toHaveBeenCalledWith({
    url: request.source.url,
    brandName: request.source.brandName,
  });
  expect(test.read).toHaveBeenCalledTimes(2);
  expect(setTimeout).toHaveBeenCalledExactlyOnceWith(3000, undefined, {
    signal: expect.any(AbortSignal),
  });
});

it("checks durable cancellation between archived requests on the remote worker", async () => {
  const test = fixture("http");
  const reader = test.adapter.brandScan;
  if (!reader) {
    throw new Error("reader fixture missing");
  }
  reader.parsePage = () => ({
    ...page,
    products: [
      { url: request.source.url, listingId: "one", variantId: null, kind: "product", title: null },
    ],
    nextPage: 2,
  });
  test.read.mockImplementation(async () => {
    vi.mocked(PostgresBrandScans.prototype.isCancellationRequested).mockResolvedValue(true);
    return { body: "{}", creditCost: 1 };
  });
  await expect(test.activity(request)).rejects.toMatchObject({ code: "BRAND_SCAN.CANCELLED" });
  expect(test.read).toHaveBeenCalledOnce();
});
