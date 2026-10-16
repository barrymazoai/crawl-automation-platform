import { createLogger } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import { MarketplaceBrandSweep } from "./brand-sweep.js";

const signal = new AbortController().signal;
const log = createLogger({ name: "marketplace-brands", destination: { write: () => undefined } });

function setup(live: number, maxLiveRuns = 50) {
  const order: string[] = [];
  const api = {
    matchBrands: vi.fn(async () => {
      order.push("match");
      return { checked: 3, matched: 2, ambiguous: 0, unmatched: 1, errors: [] };
    }),
    startMarketplaceBrands: vi.fn(async (limit: number) => {
      order.push(`start ${limit}`);
      return [{ brandId: "b" }];
    }),
  };
  const sweep = new MarketplaceBrandSweep({
    api,
    runs: { live: async () => live },
    settings: { matchLimit: 200, maxLiveRuns },
    log,
  });
  return { sweep, api, order };
}

it("matches new brands first, then starts website runs only up to the live limit", async () => {
  const fake = setup(45);
  await fake.sweep.sweep(signal);
  expect(fake.api.matchBrands).toHaveBeenCalledWith(200, signal);
  expect(fake.order).toEqual(["match", "start 5"]);
});

it("starts nothing while the live limit is reached", async () => {
  const fake = setup(50);
  await fake.sweep.sweep(signal);
  expect(fake.api.startMarketplaceBrands).not.toHaveBeenCalled();
});

it("never asks the start API for more than 100 brands", async () => {
  const fake = setup(0, 100);
  await fake.sweep.sweep(signal);
  expect(fake.api.startMarketplaceBrands).toHaveBeenCalledWith(100, signal);
});
