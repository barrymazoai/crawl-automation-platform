import { createLogger } from "@crawl-automation/platform";
import { resourceGateErrors } from "@crawl-automation/platform/errors/resource-gate";
import { brandScanErrors } from "@crawl-automation/channels-core";
import { beforeEach, expect, it, vi } from "vitest";
import { BrandScanRunner, type BrandScanRunnerDeps } from "./brand-scan-runner.js";
import { readListing, type BrandListing } from "./scan-listing.js";
import { BrandScanPermitSchema } from "./scan-permits.js";

vi.mock("./scan-listing.js", () => ({ readListing: vi.fn() }));
const listing: BrandListing = {
  pages: [],
  products: [],
  credits: 0,
  full: true,
  families: 0,
  unresolvedFamilies: 0,
};

function fixture(channel = "swanson") {
  const scan = { scanId: "scan-1", source: { channel }, revisitBatchId: "revisit-1" };
  const finish = vi.fn();
  const read = vi.fn(async () => listing);
  const deps = {
    store: { claim: async () => [scan], finish, knownListings: async () => [] },
    queue: { add: vi.fn() },
    amazonQueue: { knownListings: async () => [], add: vi.fn() },
    gatedListings: { swanson: { read } },
    log: createLogger({ name: "scan-permits", destination: { write: () => undefined } }),
  } as unknown as BrandScanRunnerDeps;
  return { runner: new BrandScanRunner(deps), finish, read, scan };
}

beforeEach(() => vi.mocked(readListing).mockReset().mockResolvedValue(listing));

it("holds the listing phase until the configured gate returns, then finishes normally", async () => {
  const test = fixture();
  let finish: (value: BrandListing) => void = () => undefined;
  test.read.mockReturnValueOnce(
    new Promise<BrandListing>((resolve) => {
      finish = resolve;
    }),
  );
  const pending = test.runner.tick(new AbortController().signal);
  await vi.waitFor(() => expect(test.read).toHaveBeenCalledOnce());
  expect(test.finish).not.toHaveBeenCalled();
  expect(readListing).not.toHaveBeenCalled();
  finish(listing);
  await pending;
  expect(test.finish).toHaveBeenCalledWith(
    "scan-1",
    expect.objectContaining({ state: "complete" }),
  );
});

it.each(["gnc", "amazon"])(
  "keeps %s on its existing listing path without a permit",
  async (channel) => {
    const test = fixture(channel);
    await test.runner.tick(new AbortController().signal);
    expect(test.read).not.toHaveBeenCalled();
    expect(readListing).toHaveBeenCalledOnce();
    expect(test.finish).toHaveBeenCalledWith(
      "scan-1",
      expect.objectContaining({ state: "complete" }),
    );
  },
);

it.each([
  resourceGateErrors.create("RESOURCE.WAIT_LIMIT"),
  brandScanErrors.create("BRAND_SCAN.ACCESS_CHALLENGE"),
])("finishes $code as Review without retry or local fallback", async (failure) => {
  const test = fixture();
  test.read.mockRejectedValueOnce(failure);
  await test.runner.tick(new AbortController().signal);
  expect(test.finish).toHaveBeenCalledWith(
    "scan-1",
    expect.objectContaining({ state: "review", code: failure.code }),
  );
  expect(test.read).toHaveBeenCalledOnce();
  expect(readListing).not.toHaveBeenCalled();
});

it("validates the permit resource and bounded wait at config load", () => {
  const valid = { taskQueue: "pipeline", resourceQueue: "resources", resourceId: "brand-scan" };
  expect(BrandScanPermitSchema.parse(valid).maxWaitSeconds).toBe(900);
  expect(BrandScanPermitSchema.parse(valid).gapAfterSeconds).toBe(0);
  expect(BrandScanPermitSchema.parse({ ...valid, gapAfterSeconds: 30 }).gapAfterSeconds).toBe(30);
  for (const invalid of [
    { resourceId: "" },
    { resourceQueue: "" },
    { maxWaitSeconds: 3601 },
    { gapAfterSeconds: -1 },
    { gapAfterSeconds: 0.5 },
    { gapAfterSeconds: "30" },
  ]) {
    expect(() => BrandScanPermitSchema.parse({ ...valid, ...invalid })).toThrow();
  }
});
