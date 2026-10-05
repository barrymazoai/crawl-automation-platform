import { expect, it } from "vitest";
import { brandScanErrors } from "@crawl-automation/channels-core";
import { scraperApiErrors } from "@crawl-automation/platform";
import { answer, setup } from "./whole-foods-search-test-support.js";
import { WholeFoodsHttpScanSettingsSchema } from "./whole-foods-http-settings.js";
import { wholeFoodsProductAddress } from "./whole-foods-address.js";
import { wholeFoodsStoreCookie } from "./whole-foods-store.js";

it("defaults to two size-100 JSON reads, configured store headers and API counts", async () => {
  const test = setup([answer([1, 2]), answer([1, 2])]);
  const result = await test.run();
  expect(test.reader.answer).toBe("json");
  expect(test.settings).toMatchObject({
    brandScanMode: "http",
    size: 100,
    maxEmptyAttempts: 5,
    emptyPauseMs: 2000,
    readPauseMs: 2000,
    requestTimeoutMs: 60000,
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
  expect(test.pause).toHaveBeenCalledExactlyOnceWith(2000);
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
    expect(product.listingId).not.toBe("B000000999");
  }
});

it("pages each read by size 100 until the API's own count is covered", async () => {
  const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
  const test = setup([
    answer(hundred, 101),
    answer([101], 101),
    answer(hundred, 101),
    answer([101], 101),
  ]);
  const result = await test.run();
  expect(result.complete).toBe(true);
  expect(
    test.read.mock.calls.map(([request]) => new URL(request.url).searchParams.get("offset")),
  ).toEqual(["0", "100", "0", "100"]);
  expect(result.metrics.reads).toEqual(
    ["read-1", "read-2"].map((read) => ({
      read,
      pages: 2,
      cards: 101,
      products: 101,
      availableCounts: [101, 101],
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
  expect(test.pause.mock.calls).toEqual([[2000], [2000]]);
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
    code: "WHOLEFOODS.BRAND_NOT_LISTED",
    cooldownRequested: false,
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
    code: "WHOLEFOODS.EMPTY_EXHAUSTED",
    metrics: { unionSize: 2 },
  });
  expect(result.pages).toHaveLength(1);
  expect(result.metrics.reads.map((read) => read.succeeded)).toEqual([true, false]);
});

it("counts the union even when different successful reads have different totals", async () => {
  const test = setup([answer([2, 1]), answer([3, 2, 4])]);
  // Owner 2026-10-05: each read complete against its own total proves the list; missing items are revisited.
  expect(await test.run()).toMatchObject({
    complete: true,
    statedTotal: 3,
    metrics: {
      readsFinished: true,
      catalogueAgreement: false,
      unionSize: 4,
      reads: [{ availableCounts: [2] }, { availableCounts: [3] }],
    },
  });
});

it("takes the union when equal counts list different ASINs (owner 2026-10-05)", async () => {
  const result = await setup([answer([1, 2]), answer([2, 3])]).run();
  expect(result).toMatchObject({
    complete: true,
    credits: 2,
    metrics: { readsFinished: true, catalogueAgreement: false, unionSize: 3 },
  });
});

it("accepts matching full sets in different orders", async () => {
  const result = await setup([answer([1, 2]), answer([2, 1])]).run();
  expect(result).toMatchObject({
    complete: true,
    metrics: { readsFinished: true, catalogueAgreement: true, unionSize: 2 },
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
  [answer([1, 2], 101), answer([2], 101)],
  [answer([1, 2], 101), answer([3], 2)],
  [answer([1], 101), answer([3], 101)],
])("fails closed on duplicate, shifting or incomplete page coverage", async (first, second) => {
  const test = setup([first, second, first, second]);
  expect(await test.run()).toMatchObject({
    complete: false,
    code: "WHOLEFOODS.LISTING_UNVERIFIED",
  });
});

it("does not retry empty cards with a positive total or canary a later empty page", async () => {
  const sparse = setup([answer([], 2), answer([], 2)]);
  expect(await sparse.run()).toMatchObject({ complete: false, cooldownRequested: false });
  expect(sparse.read).toHaveBeenCalledTimes(2);
  const later = setup([answer([1, 2], 101), answer([]), answer([1], 101)], {
    maxEmptyAttempts: 1,
    size: 2,
  });
  expect(await later.run()).toMatchObject({ complete: false, metrics: { unionSize: 2 } });
  expect(later.read).toHaveBeenCalledTimes(3);
});

it("bounds paging and respects cancellation without another paid attempt", async () => {
  const capped = setup([answer([1], 101)], { maxPages: 1, size: 1 });
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

it.each([
  [
    [1, 2],
    [1, 2, 3],
  ],
  [
    [1, 2, 3],
    [2, 1],
  ],
])(
  "accepts complete subsets as their union while recording them as unstable (owner 2026-10-05)",
  async (first, second) => {
    const result = await setup([answer(first), answer(second)]).run();
    expect(result).toMatchObject({
      complete: true,
      metrics: { catalogueAgreement: true, catalogueStable: false, unionSize: 3 },
    });
    expect(result.metrics.attempts).toEqual([
      expect.objectContaining({
        read: "read-1",
        page: 1,
        attempt: 1,
        archiveKey: "read-1-page-1-attempt-1.json",
        creditCost: 1,
        empty: false,
      }),
      expect.objectContaining({
        read: "read-2",
        page: 1,
        attempt: 1,
        archiveKey: "read-2-page-1-attempt-1.json",
        creditCost: 1,
        empty: false,
      }),
    ]);
  },
);

it("applies bounded timing overrides without widening paid retries", async () => {
  const test = setup([answer([]), answer([1]), answer([1])], {
    emptyPauseMs: 17,
    readPauseMs: 23,
    requestTimeoutMs: 12000,
  });
  await test.run();
  expect(test.pause.mock.calls).toEqual([[17], [23]]);
  expect(test.read.mock.calls.every(([request]) => request.timeoutMs === 12000)).toBe(true);
  for (const invalid of [
    { size: 101 },
    { size: 0 },
    { maxEmptyAttempts: 6 },
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 70001 },
    { emptyPauseMs: -1 },
  ]) {
    expect(WholeFoodsHttpScanSettingsSchema.safeParse(invalid).success).toBe(false);
  }
});

it("preserves an actual provider throttle without retry or a canary", async () => {
  const test = setup([scraperApiErrors.create("SCRAPERAPI.THROTTLED")]);
  expect(await test.run()).toMatchObject({ code: "SCRAPERAPI.THROTTLED", complete: false });
  expect(test.read).toHaveBeenCalledOnce();
});
