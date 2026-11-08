import { brandScanErrors } from "@crawl-automation/channels-core";
import { expect, it, vi } from "vitest";
import { LookedUpBrandSources } from "./looked-up-sources.js";
import type { ScanSource } from "../brand-scans/scan-model.js";

const uuid = (num: number) => `${String(num).repeat(8)}-1111-4111-8111-111111111111`;
const source = (num: number, brandName: string, brandId = uuid(num)): ScanSource => ({
  sourceId: uuid(num),
  brandId,
  brandName,
  channel: "amazon",
  url: `https://www.amazon.com/stores/${brandName}/page/X`,
  enabled: true,
});

function setup(rows: ScanSource[], lookup: (source: ScanSource) => Promise<string | null>) {
  const addDisabledSources = vi.fn(async (added: readonly unknown[]) => ({
    created: added.length,
    existing: 0,
  }));
  const lookups = vi.fn(lookup);
  const service = new LookedUpBrandSources({
    sources: { sources: vi.fn(async () => rows) },
    store: { brandNames: vi.fn(), addDisabledSources },
    channel: "amazon-in",
    concurrency: 2,
    lookup: lookups,
    log: { info: vi.fn() } as never,
  });
  return { service, addDisabledSources, lookups };
}

it("looks each brand up once and adds the sources found, disabled", async () => {
  const brand = uuid(1);
  const test = setup(
    [source(1, "Redcon1", brand), source(2, "Redcon1", brand), source(3, "Boiron")],
    async ({ brandName }) => (brandName === "Redcon1" ? "https://www.amazon.in/s?k=Redcon1" : null),
  );
  const result = await test.service.import(
    { sourceIds: [uuid(1), uuid(2), uuid(3), uuid(4)] },
    new AbortController().signal,
  );
  expect(test.lookups).toHaveBeenCalledTimes(2);
  expect(test.addDisabledSources).toHaveBeenCalledWith([
    { brandId: brand, channel: "amazon-in", url: "https://www.amazon.in/s?k=Redcon1" },
  ]);
  expect(result).toEqual({
    created: 1,
    existing: 0,
    missing: 1,
    notFound: ["Boiron"],
    failed: [],
  });
});

it("reports a failed lookup and goes on with the other brands", async () => {
  const test = setup([source(1, "Six Star"), source(2, "Zesty Paws")], async ({ brandName }) => {
    if (brandName === "Six Star") {
      throw brandScanErrors.create("BRAND_SCAN.ACCESS_CHALLENGE");
    }
    return "https://www.amazon.in/s?k=Zesty+Paws";
  });
  const result = await test.service.import(
    { sourceIds: [uuid(1), uuid(2)] },
    new AbortController().signal,
  );
  expect(result.created).toBe(1);
  expect(result.notFound).toEqual([]);
  expect(result.failed).toEqual([{ brandName: "Six Star", code: "BRAND_SCAN.ACCESS_CHALLENGE" }]);
});
