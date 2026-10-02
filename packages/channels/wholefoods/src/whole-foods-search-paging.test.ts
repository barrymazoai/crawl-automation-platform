import { expect, it } from "vitest";
import { answer, setup } from "./whole-foods-search-test-support.js";

const range = (start: number, count: number) =>
  Array.from({ length: count }, (_, index) => start + index);

it("reads three offset pages per observation, ending on a short page", async () => {
  const pages = [
    answer(range(1, 100), 205),
    answer(range(101, 100), 205),
    answer(range(201, 5), 205),
  ];
  const test = setup([...pages, ...pages]);
  const result = await test.run();
  expect(result).toMatchObject({ complete: true, credits: 6, statedTotal: 205 });
  expect(result.metrics.reads.map((read) => [read.pages, read.products])).toEqual([
    [3, 205],
    [3, 205],
  ]);
  expect(
    test.read.mock.calls.map(([request]) => new URL(request.url).searchParams.get("offset")),
  ).toEqual(["0", "100", "200", "0", "100", "200"]);
  expect(result.metrics.attempts.map((attempt) => attempt.archiveKey)).toEqual(
    [1, 2].flatMap((read) => [1, 2, 3].map((page) => `read-${read}-page-${page}-attempt-1.json`)),
  );
});

it("deduplicates re-ranked overlapping pages and proves completeness with the two-read union", async () => {
  const test = setup(
    [
      answer([1, 2], 5),
      answer([2, 3], 5),
      answer([4], 5),
      answer([2, 3], 5),
      answer([4, 5], 5),
      answer([5], 5),
    ],
    { size: 2 },
  );
  const result = await test.run();
  expect(result).toMatchObject({
    complete: true,
    statedTotal: 5,
    code: null,
    metrics: { unionSize: 5, catalogueAgreement: false, catalogueStable: false },
  });
  expect(result.metrics.reads.map((read) => [read.cards, read.products, read.succeeded])).toEqual([
    [5, 4, false],
    [5, 4, false],
  ]);
});

it("continues past the reported total on a full page and refuses contradictory coverage", async () => {
  const test = setup([answer([1, 2], 2), answer([3], 2), answer([1, 2], 2), answer([3], 2)], {
    size: 2,
  });
  expect(await test.run()).toMatchObject({ complete: false, metrics: { unionSize: 3 } });
  expect(test.read).toHaveBeenCalledTimes(4);
});

it("stops on a short page even when the API total is higher; agreement is insufficient", async () => {
  const test = setup([answer([1], 178), answer([1], 178)], { size: 20 });
  expect(await test.run()).toMatchObject({
    complete: false,
    statedTotal: 178,
    metrics: { unionSize: 1 },
  });
  expect(test.read).toHaveBeenCalledTimes(2);
});

it("retries a later zero-count empty page five times, then ends each read", async () => {
  const pages = [answer([1, 2], 2), ...Array<string>(5).fill(answer([]))];
  const test = setup([...pages, ...pages], { size: 2 });
  expect(await test.run()).toMatchObject({ complete: true, credits: 12, cooldownRequested: false });
  expect(test.read.mock.calls.map(([request]) => request.label)).toEqual(
    [1, 2].flatMap((read) => [
      `read-${read}-page-1-attempt-1`,
      ...range(1, 5).map((attempt) => `read-${read}-page-2-attempt-${attempt}`),
    ]),
  );
});

it("recovers an empty later page without repeating any nonempty page", async () => {
  const test = setup(
    [answer([1, 2], 3), answer([]), answer([3], 3), answer([1, 2], 3), answer([3], 3)],
    { size: 2 },
  );
  expect(await test.run()).toMatchObject({ complete: true, credits: 5 });
  expect(test.read.mock.calls.map(([request]) => request.label)).toEqual([
    "read-1-page-1-attempt-1",
    "read-1-page-2-attempt-1",
    "read-1-page-2-attempt-2",
    "read-2-page-1-attempt-1",
    "read-2-page-2-attempt-1",
  ]);
});

it("bounds a repeated full page even when offsets never yield new products", async () => {
  const test = setup(Array<string>(3).fill(answer([1, 2], 3)), { size: 2, maxPages: 3 });
  expect(await test.run()).toMatchObject({
    complete: false,
    code: "BRAND_SCAN.PAGE_LIMIT",
    metrics: { unionSize: 2 },
  });
  expect(test.read).toHaveBeenCalledTimes(3);
});

it.each([undefined, null])(
  "keeps a missing available count partial (%s), ignoring approximate counts and facets",
  async (total) => {
    const body = JSON.stringify({
      mainResultSet: {
        searchResults: [{ asin: "B000000001" }],
        availableTotalResultCount: total,
        approximateTotalResultCount: 1,
      },
      facets: [{ count: 1 }],
      nextPageToken: "unverified-token",
    });
    expect(await setup([body, body]).run()).toMatchObject({
      complete: false,
      statedTotal: null,
      metrics: { unionSize: 1 },
    });
  },
);

it("marks changing totals partial even when the union reaches the largest total", async () => {
  expect(await setup([answer([1], 1), answer([1, 2], 2)]).run()).toMatchObject({
    complete: false,
    statedTotal: null,
    metrics: { unionSize: 2 },
  });
});
