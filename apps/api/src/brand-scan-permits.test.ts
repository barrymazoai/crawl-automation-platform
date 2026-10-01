import { PostgresBrandScans } from "@crawl-automation/adapters";
import type { ListingStateService, QueueService } from "@crawl-automation/app";
import { ListingPages } from "@crawl-automation/channels-core";
import { createLogger, type Database, type TemporalClient } from "@crawl-automation/platform";
import { afterEach, expect, it, vi } from "vitest";
import { BrandScanSettingsSchema } from "./brand-scan-config.js";
import { brandScanParts } from "./brand-scan-parts.js";
import fixture from "./fixtures/api-config.json" with { type: "json" };

afterEach(() => vi.restoreAllMocks());

it("wires only the configured channel to a ResourceGate listing workflow", async () => {
  const scanId = "11111111-1111-4111-8111-111111111111";
  const source = {
    sourceId: "22222222-2222-4222-8222-222222222222",
    channel: "swanson",
    url: "https://www.swansonvitamins.com/collections/brand-now-foods",
  };
  vi.spyOn(PostgresBrandScans.prototype, "claim").mockResolvedValue([
    { scanId, source } as Awaited<ReturnType<PostgresBrandScans["claim"]>>[number],
  ]);
  vi.spyOn(PostgresBrandScans.prototype, "knownListings").mockResolvedValue([]);
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
      swanson: {
        taskQueue: "pipeline",
        resourceQueue: "resources",
        resourceId: "swanson-brand-scan",
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
          resources: {
            queue: "resources",
            maxWaitSeconds: 900,
            activities: { readBrandListing: [{ resourceId: "swanson-brand-scan", units: 1 }] },
          },
        },
      ],
    }),
  );
  expect(read).not.toHaveBeenCalled();
  expect(finish).toHaveBeenCalledWith(scanId, expect.objectContaining({ state: "complete" }));
});

it("defaults Whole Foods pacing and accepts validated overrides without changing Swanson", () => {
  const defaults = BrandScanSettingsSchema.parse(fixture.brandScans);
  expect(defaults.permits.wholefoods).toEqual({
    taskQueue: "browser",
    resourceQueue: "v3.resources.v1",
    resourceId: "wholefoods-brand-scan",
    maxWaitSeconds: 900,
    gapAfterSeconds: 60,
    cooldownSeconds: 1800,
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
