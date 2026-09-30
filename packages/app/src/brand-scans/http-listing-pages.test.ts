import * as timers from "node:timers/promises";
import type { BrandScanReader, ChannelAdapter } from "@crawl-automation/channels-core";
import { beforeEach, expect, it, vi } from "vitest";
import { readPages } from "./http-listing-pages.js";

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof timers>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});
beforeEach(() => vi.mocked(timers.setTimeout).mockReset());

function fixture(resolve = true, requestIntervalMs = 3000) {
  const sourceUrl = "https://example.com/brand";
  const reader: BrandScanReader = {
    sourceUrl: (url) => url,
    pageUrl: (url, page) => `${url}?page=${page}`,
    answer: "json",
    maxBytes: 1000,
    maxPages: 2,
    parsePage: ({ page }) => ({
      products: [
        { url: sourceUrl, listingId: "one", variantId: null, title: null, kind: "product" },
      ],
      cards: 1,
      nextPage: page === 1 ? 2 : null,
      statedTotal: 2,
    }),
    complete: () => true,
  };
  if (resolve) {
    reader.resolve = {
      pageUrl: (url) => url,
      parsePage: () => sourceUrl,
      answer: "html",
      maxBytes: 1000,
    };
  }
  const read = vi.fn(async () => ({
    body: "",
    archiveKey: "test",
    creditCost: 1,
    fromArchive: false,
  }));
  const work = {
    scan: { scanId: "scan", source: { sourceId: "source", channel: "gnc", url: sourceUrl } },
    adapter: {
      id: "gnc",
      httpPolicy: { origins: ["https://example.com"] },
    } as unknown as ChannelAdapter,
    reader,
    pages: { read },
    requestIntervalMs,
  };
  return { work, read };
}

it.each([true, false])("pauses only between requests (entry resolver: %s)", async (resolve) => {
  const test = fixture(resolve);
  const signal = new AbortController().signal;
  const sleep = vi.mocked(timers.setTimeout).mockImplementation(async () => {
    expect(test.read).toHaveBeenCalledTimes(sleep.mock.calls.length);
    return undefined;
  });
  const result = await readPages(test.work, signal);
  expect(result.pages).toHaveLength(2);
  expect(test.read).toHaveBeenCalledTimes(resolve ? 3 : 2);
  expect(sleep).toHaveBeenCalledTimes(resolve ? 2 : 1);
  for (const call of sleep.mock.calls) {
    expect(call).toEqual([3000, undefined, { signal }]);
  }
});

it.each([undefined, 0])("does not wait when the interval is %s", async (requestIntervalMs) => {
  const test = fixture(true, 0);
  const sleep = vi.mocked(timers.setTimeout);
  if (requestIntervalMs === undefined) {
    delete (test.work as { requestIntervalMs?: number }).requestIntervalMs;
  }
  await readPages(test.work, new AbortController().signal);
  expect(sleep).not.toHaveBeenCalled();
  expect(test.read).toHaveBeenCalledTimes(3);
});

it("cancels a real timer immediately without starting the next page", async () => {
  const test = fixture(true, 60_000);
  const controller = new AbortController();
  const sleep = vi.mocked(timers.setTimeout);
  const pending = readPages(test.work, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
  await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
  expect(test.read).toHaveBeenCalledOnce();
  controller.abort();
  await rejected;
  expect(test.read).toHaveBeenCalledOnce();
}, 1000);
