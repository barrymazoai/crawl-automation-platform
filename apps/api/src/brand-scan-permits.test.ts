import { PostgresBrandScans } from "@crawl-automation/adapters";
import type { ListingStateService, QueueService } from "@crawl-automation/app";
import { ListingPages } from "@crawl-automation/channels-core";
import { createLogger, type Database, type TemporalClient } from "@crawl-automation/platform";
import { afterEach, expect, it, vi } from "vitest";
import { BrandScanSettingsSchema } from "./brand-scan-config.js";
import { brandScanParts } from "./brand-scan-parts.js";
import fixture from "./fixtures/api-config.json" with { type: "json" };

afterEach(() => vi.restoreAllMocks());

it.each(["swanson", "wholefoods"])(
  "wires %s to the HTTP ResourceGate listing workflow",
  async (channel) => {
    const scanId = "11111111-1111-4111-8111-111111111111";
    const source = {
      sourceId: "22222222-2222-4222-8222-222222222222",
      channel,
      url:
        channel === "swanson"
          ? "https://www.swansonvitamins.com/collections/brand-now-foods"
          : "https://www.wholefoodsmarket.com/grocery/search?k=Nordic+Naturals&rh=p_123%3A234060",
    };
    vi.spyOn(PostgresBrandScans.prototype, "claim").mockResolvedValue([
      { scanId, source } as Awaited<ReturnType<PostgresBrandScans["claim"]>>[number],
    ]);
    vi.spyOn(PostgresBrandScans.prototype, "knownListings").mockResolvedValue([]);
    vi.spyOn(PostgresBrandScans.prototype, "isCancellationRequested").mockResolvedValue(false);
    const finish = vi.spyOn(PostgresBrandScans.prototype, "finish").mockResolvedValue();
    const read = vi.spyOn(ListingPages.prototype, "read");
    const start = vi.fn(async () => ({
      result: async () => ({
        pages: [],
        products: [],
        families: 0,
        unresolvedFamilies: 0,
        full: true,
        credits: 0,
      }),
      cancel: vi.fn(),
    }));
    const settings = BrandScanSettingsSchema.parse({
      ...fixture.brandScans,
      permits: {
        [channel]: {
          taskQueue: "pipeline",
          resourceQueue: "resources",
          resourceId: `${channel}-brand-scan`,
          gapAfterSeconds: 30,
        },
      },
    });
    const { runner } = brandScanParts({
      settings,
      database: {} as Database,
      queue: {} as QueueService,
      listingStates: {} as ListingStateService,
      temporal: { client: { workflow: { start } } } as unknown as TemporalClient,
      log: createLogger({ name: "scan-permits", destination: { write: () => undefined } }),
    });
    await runner?.tick(new AbortController().signal);
    expect(start).toHaveBeenCalledWith(
      "BrandListingWorkflow",
      expect.objectContaining({
        taskQueue: "pipeline",
        args: [
          {
            scanId,
            source,
            gapAfterSeconds: 30,
            ...(channel === "wholefoods" ? { cooldownSeconds: 60 } : {}),
            resources: {
              queue: "resources",
              maxWaitSeconds: channel === "wholefoods" ? 120 : 900,
              activities: { readBrandListing: [{ resourceId: `${channel}-brand-scan`, units: 1 }] },
            },
          },
        ],
      }),
    );
    expect(read).not.toHaveBeenCalled();
    // Older Whole Foods responses have no catalogue-agreement proof, even when full was true.
    expect(finish).toHaveBeenCalledWith(
      scanId,
      expect.objectContaining({
        state: channel === "wholefoods" ? "partial" : "complete",
        full: channel !== "wholefoods",
      }),
    );
  },
);

it("defaults Whole Foods pacing and accepts validated overrides without changing Swanson", () => {
  const defaults = BrandScanSettingsSchema.parse(fixture.brandScans);
  expect(defaults.permits.wholefoods).toEqual({
    taskQueue: "v3.pipeline.product.v1",
    resourceQueue: "v3.resources.v1",
    resourceId: "wholefoods-brand-scan",
    maxWaitSeconds: 120,
    gapAfterSeconds: 2,
    cooldownSeconds: 60,
  });
  const settings = BrandScanSettingsSchema.parse({
    ...fixture.brandScans,
    permits: {
      wholefoods: { gapAfterSeconds: 90, cooldownSeconds: 3600 },
      swanson: {
        taskQueue: "pipeline",
        resourceQueue: "resources",
        resourceId: "swanson-brand-scan",
      },
    },
  });
  expect(settings.permits.wholefoods).toMatchObject({ gapAfterSeconds: 90, cooldownSeconds: 3600 });
  expect(settings.permits.swanson?.gapAfterSeconds).toBe(0);
  for (const invalid of [
    { gapAfterSeconds: -1 },
    { cooldownSeconds: 0.5 },
    { resourceId: "other" },
  ]) {
    expect(
      BrandScanSettingsSchema.safeParse({ ...fixture.brandScans, permits: { wholefoods: invalid } })
        .success,
    ).toBe(false);
  }
});

it("gives Costco its own global browser permit on the shared queue", () => {
  const defaults = BrandScanSettingsSchema.parse(fixture.brandScans);
  expect(defaults.permits.costco).toEqual({
    taskQueue: "browser",
    resourceQueue: "v3.resources.v1",
    resourceId: "costco-brand-scan",
    maxWaitSeconds: 900,
    gapAfterSeconds: 60,
    cooldownSeconds: 1800,
  });
  const configured = BrandScanSettingsSchema.parse({
    ...fixture.brandScans,
    permits: { costco: { taskQueue: "costco-browser", gapAfterSeconds: 90 } },
  });
  expect(configured.permits.costco).toMatchObject({
    taskQueue: "costco-browser",
    gapAfterSeconds: 90,
  });
  expect(configured.permits.wholefoods).toEqual(defaults.permits.wholefoods);
  expect(
    BrandScanSettingsSchema.safeParse({
      ...fixture.brandScans,
      permits: { costco: { resourceId: "local-costco" } },
    }).success,
  ).toBe(false);
});

it("chooses the mode's execution queue while retaining one global Whole Foods permit", () => {
  const http = BrandScanSettingsSchema.parse({ ...fixture.brandScans, browserQueue: undefined });
  expect(http.wholefoods.brandScanMode).toBe("http");
  expect(http.permits.wholefoods?.taskQueue).toBe("v3.pipeline.product.v1");
  const browser = BrandScanSettingsSchema.parse({
    ...fixture.brandScans,
    wholefoods: { brandScanMode: "browser" },
  });
  expect(browser.permits.wholefoods).toMatchObject({
    taskQueue: "browser",
    resourceId: "wholefoods-brand-scan",
    gapAfterSeconds: 60,
    cooldownSeconds: 1800,
  });
  expect(
    BrandScanSettingsSchema.safeParse({
      ...fixture.brandScans,
      wholefoods: { brandScanMode: "other" },
    }).success,
  ).toBe(false);
});
