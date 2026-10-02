import { expect, it } from "vitest";
import { ApiConfigSchema } from "./config.js";

const queue = ApiConfigSchema.shape.queue;

it("defaults existing queue configs and omitted queue sections to a 24-hour scan window", () => {
  const expected = { dispatcher: { intervalMs: 5_000 }, recentScanSkipHours: 24 };
  expect(queue.parse(undefined)).toEqual(expected);
  expect(queue.parse({})).toEqual(expected);
  expect(queue.parse({ dispatcher: { intervalMs: 5_000 } })).toEqual(expected);
});

it.each([0, 12, 48, 8_760])("accepts a global %i-hour window", (recentScanSkipHours) => {
  expect(queue.parse({ recentScanSkipHours }).recentScanSkipHours).toBe(recentScanSkipHours);
});

it.each([-1, 0.5, "24", null, 8_761, Infinity])(
  "rejects an invalid window %s",
  (recentScanSkipHours) => {
    expect(queue.safeParse({ recentScanSkipHours }).success).toBe(false);
  },
);
