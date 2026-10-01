import { expect, it, vi } from "vitest";
import { brandScanErrors, type ListingPolicyRequest } from "@crawl-automation/channels-core";
import { scraperApiErrors } from "@crawl-automation/platform";
import { createWholeFoodsHttpReader } from "./whole-foods-http-reader.js";
import { WholeFoodsHttpScanSettingsSchema } from "./whole-foods-http-settings.js";
import { wholeFoodsProductAddress, wholeFoodsBrandSearchUrl } from "./whole-foods-address.js";
import { wholeFoodsStoreCookie } from "./whole-foods-store.js";

const sourceUrl = wholeFoodsBrandSearchUrl({ name: "Nordic Naturals", amazonBrandId: "234060" });
const asin = (number: number) => `B0${String(number).padStart(8, "0")}`;
const answer = (ids: number[], total = ids.length) =>
  JSON.stringify({
    mainResultSet: {
      searchResults: ids.map((number) => ({ asin: asin(number), parentAsin: asin(999) })),
      availableTotalResultCount: total,
      approximateTotalResultCount: 9999,
    },
    deliveryTargets: [],
    searchRobotSignals: {},
  });

function setup(answers: (string | Error)[], config: Record<string, unknown> = {}) {
  const settings = WholeFoodsHttpScanSettingsSchema.parse(config);
  const reader = createWholeFoodsHttpReader(settings);
  const readList = reader.readList;
  if (!readList) {
    throw new Error("HTTP reader must provide its policy");
  }
  let index = 0;
  const read = vi.fn(async (request: ListingPolicyRequest) => {
    const body = answers[index++];
    if (body instanceof Error) {
      throw body;
    }
    if (body === undefined) {
      throw new Error("Unexpected extra paid request");
    }
    return { body, archiveKey: `${request.label}.json`, creditCost: 1, fromArchive: false };
  });
  const pause = vi.fn(async (_milliseconds: number): Promise<void> => undefined);
  const controller = new AbortController();
  return {
    reader,
    settings,
    read,
    pause,
    controller,
    run: () => readList({ sourceUrl, read, pause, signal: controller.signal }),
  };
}

it("defaults to two size-100 JSON reads, configured store headers and API counts", async () => {
  const test = setup([answer([1, 2]), answer([1, 2])]);
  const result = await test.run();
  expect(test.reader.answer).toBe("json");
  expect(test.settings).toMatchObject({
    brandScanMode: "http",
    size: 100,
    maxEmptyAttempts: 5,
    emptyPauseMs: 2000,
    readPauseMs: 60000,
  });
  expect(result).toMatchObject({
    complete: true,
    soldHere: true,
    statedTotal: 2,
    credits: 2,
    cooldownRequested: false,
    code: null,
    metrics: { storeId: "10259", unionSize: 2 },
  });
  expect(test.pause).toHaveBeenCalledExactlyOnceWith(60000);
  const request = test.read.mock.calls[0]?.[0];
  const url = new URL(request?.url ?? "");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    text: "Nordic Naturals",
    filters: "p_123:234060",
    old: "A0GA",
    sort: "relevanceblender",
    programType: "GROCERY",
    categories: "18473610011",
    offset: "0",
    size: "100",
  });
  expect(request?.options).toMatchObject({
    render: false,
    premium: false,
    sessionNumber: null,
    headers: {
      cookie: wholeFoodsStoreCookie(test.settings.store),
      "content-type": "application/json",
      accept: "*/*",
    },
  });
  for (const product of result.pages.flatMap((page) => page.products)) {
    expect(wholeFoodsProductAddress(product.url).listingId).toBe(product.listingId);
    expect(product.listingId).not.toBe(asin(999));
  }
});

it("pages each read by configured size until the API's own count is covered", async () => {
  const test = setup([answer([1, 2], 3), answer([3], 3), answer([1, 2], 3), answer([3], 3)], {
    size: 2,
  });
  const result = await test.run();
  expect(result.complete).toBe(true);
  expect(
    test.read.mock.calls.map(([request]) => new URL(request.url).searchParams.get("offset")),
  ).toEqual(["0", "2", "0", "2"]);
  expect(result.metrics.reads).toEqual(
    ["read-1", "read-2"].map((read) => ({
      read,
      pages: 2,
      cards: 3,
      products: 3,
      availableCounts: [3, 3],
      succeeded: true,
      code: null,
    })),
  );
});

it("repeats only empty pages, counts every try and credit, and pauses before repeats", async () => {
  const test = setup([answer([]), answer([1]), answer([1])]);
  const result = await test.run();
  expect(result).toMatchObject({ complete: true, credits: 3 });
  expect(result.metrics.attempts.map(({ empty, attempt }) => [empty, attempt])).toEqual([
    [true, 1],
    [false, 2],
    [false, 1],
  ]);
  expect(test.pause.mock.calls).toEqual([[2000], [60000]]);
  expect(test.read.mock.calls[0]?.[0].url).toBe(test.read.mock.calls[1]?.[0].url);
  expect(new Set(test.read.mock.calls.map(([request]) => request.label)).size).toBe(3);
});

it("accepts not sold only after five empty tries and a healthy unfiltered canary", async () => {
  const test = setup([...Array<string>(5).fill(answer([])), answer([999])]);
  const result = await test.run();
  expect(result).toMatchObject({
    soldHere: false,
    complete: false,
    credits: 6,
    pages: [],
    code: null,
    cooldownRequested: true,
    metrics: { unionSize: 0 },
  });
  const url = new URL(test.read.mock.calls[5]?.[0].url ?? "");
  expect(url.searchParams.get("text")).toBe("365 by Whole Foods Market");
  expect(url.searchParams.has("filters")).toBe(false);
  expect(result.metrics.reads.map((read) => read.read)).toEqual(["read-1", "canary"]);
});

it("reports throttling when brand and canary exhaust their empty attempts", async () => {
  const test = setup(Array<string>(10).fill(answer([])));
  const result = await test.run();
  expect(result).toMatchObject({
    code: "WHOLEFOODS.SEARCH_THROTTLED",
    complete: false,
    credits: 10,
    cooldownRequested: true,
  });
  expect(result).not.toHaveProperty("soldHere");
  expect(test.read).toHaveBeenCalledTimes(10);
});

it("keeps the first read when the second exhausts its empty tries; no canary", async () => {
  const test = setup([answer([1, 2]), ...Array<string>(5).fill(answer([]))]);
  const result = await test.run();
  expect(result).toMatchObject({
    complete: false,
    credits: 6,
    soldHere: true,
    code: "WHOLEFOODS.SEARCH_THROTTLED",
    metrics: { unionSize: 2 },
  });
  expect(result.pages).toHaveLength(1);
  expect(result.metrics.reads.map((read) => read.succeeded)).toEqual([true, false]);
});

it("counts the union even when different successful reads have different totals", async () => {
  const test = setup([answer([2, 1]), answer([3, 2, 4])]);
  expect(await test.run()).toMatchObject({
    complete: true,
    statedTotal: 2,
    metrics: { unionSize: 4, reads: [{ availableCounts: [2] }, { availableCounts: [3] }] },
  });
});

it.each([
  ["not JSON", "<html>soft error</html>", "BRAND_SCAN.NOT_JSON"],
  ["wrong shape", '{"mainResultSet":{}}', "BRAND_SCAN.NOT_JSON"],
  [
    "HTTP error",
    brandScanErrors.create("BRAND_SCAN.HTTP_STATUS", { details: { creditCost: 2 } }),
    "BRAND_SCAN.HTTP_STATUS",
  ],
  [
    "provider",
    scraperApiErrors.create("SCRAPERAPI.PROVIDER_FAILURE"),
    "SCRAPERAPI.PROVIDER_FAILURE",
  ],
])("does not retry %s on either read", async (_name, failure, code) => {
  const first = setup([failure]);
  const result = await first.run();
  expect(result).toMatchObject({ complete: false, code, cooldownRequested: false });
  expect(first.read).toHaveBeenCalledOnce();
  const second = setup([answer([1]), failure]);
  expect(await second.run()).toMatchObject({
    complete: false,
    soldHere: true,
    code,
    metrics: { unionSize: 1 },
  });
  expect(second.read).toHaveBeenCalledTimes(2);
});

it("records the paid HTTP error's cost and keeps a canary failure's own code", async () => {
  const error = brandScanErrors.create("BRAND_SCAN.HTTP_STATUS", { details: { creditCost: 2 } });
  const test = setup([answer([]), error], { maxEmptyAttempts: 1 });
  expect(await test.run()).toMatchObject({ credits: 3, code: "BRAND_SCAN.HTTP_STATUS" });
  expect(test.read).toHaveBeenCalledTimes(2);
});

it.each([
  [answer([1, 2], 3), answer([2], 3)],
  [answer([1, 2], 3), answer([3], 2)],
  [answer([1], 3), answer([3], 3)],
])("fails closed on duplicate, shifting or incomplete page coverage", async (first, second) => {
  const test = setup([first, second, first, second], { size: 2 });
  expect(await test.run()).toMatchObject({
    complete: false,
    code: "WHOLEFOODS.LISTING_UNVERIFIED",
  });
});

it("does not retry empty cards with a positive total or canary a later empty page", async () => {
  const sparse = setup([answer([], 2), answer([], 2)]);
  expect(await sparse.run()).toMatchObject({ complete: false, cooldownRequested: false });
  expect(sparse.read).toHaveBeenCalledTimes(2);
  const later = setup([answer([1], 2), answer([])], { size: 1, maxEmptyAttempts: 1 });
  expect(await later.run()).toMatchObject({ complete: false, metrics: { unionSize: 1 } });
  expect(later.read).toHaveBeenCalledTimes(2);
});

it("bounds paging and respects cancellation without another paid attempt", async () => {
  const capped = setup([answer([1], 2)], { size: 1, maxPages: 1 });
  expect(await capped.run()).toMatchObject({ code: "BRAND_SCAN.PAGE_LIMIT", complete: false });
  const cancelled = setup([answer([])]);
  cancelled.pause.mockImplementation(async () => cancelled.controller.abort());
  await expect(cancelled.run()).rejects.toThrow();
  expect(cancelled.read).toHaveBeenCalledOnce();
});

it("applies the same empty retry policy to the single canary page", async () => {
  const test = setup([answer([]), answer([]), answer([]), answer([99], 200)], {
    maxEmptyAttempts: 2,
  });
  const result = await test.run();
  expect(result).toMatchObject({ soldHere: false, complete: false, credits: 4, pages: [] });
  expect(result.metrics.attempts.map((attempt) => [attempt.read, attempt.attempt])).toEqual([
    ["read-1", 1],
    ["read-1", 2],
    ["canary", 1],
    ["canary", 2],
  ]);
  expect(test.read).toHaveBeenCalledTimes(4);
});

it("does not retry a provider timeout or an unverified archive", async () => {
  for (const error of [
    scraperApiErrors.create("SCRAPERAPI.EXECUTION_UNKNOWN"),
    brandScanErrors.create("BRAND_SCAN.ARCHIVE_UNVERIFIED"),
  ]) {
    const test = setup([error]);
    expect(await test.run()).toMatchObject({
      code: error.code,
      complete: false,
      cooldownRequested: false,
      metrics: { attempts: [{ code: error.code, creditCost: null }] },
    });
    expect(test.read).toHaveBeenCalledOnce();
  }
});
