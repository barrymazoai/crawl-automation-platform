import { BrandScanRunnerSettingsSchema } from "@crawl-automation/app";
import { ListingFetchSettingsSchema } from "@crawl-automation/channels-core";
import { BrandScanPermitsSchema, withScanPermitDefaults } from "./browser-scan-permit-settings.js";
import { R2ScopeSchema } from "@crawl-automation/platform";
import { z } from "zod";
import { WholeFoodsHttpScanSettingsSchema } from "@crawl-automation/channels-wholefoods";
import { SwansonBrandScanSettingsSchema } from "@crawl-automation/channel-swanson";

/** The API's brand-scan settings (private config): R2 to archive listing pages, ScraperAPI to fetch them. */
export const BrandScanSettingsSchema = z.preprocess(
  withScanPermitDefaults,
  ListingFetchSettingsSchema.extend({
    swanson: SwansonBrandScanSettingsSchema.optional(),
    wholefoods: WholeFoodsHttpScanSettingsSchema.prefault({}),
    r2: R2ScopeSchema,
    r2Credentials: z.strictObject({
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
    }),
    /** Channels with a listing permit run on a worker through the existing Temporal ResourceGate. */
    permits: BrandScanPermitsSchema,
    runner: BrandScanRunnerSettingsSchema.default({
      intervalMs: 5_000,
      concurrent: 4,
      staleMs: 1_800_000,
    }),
    /**
     * The browser task queue for Amazon Store pages and configured browser fallbacks.
     * Without it browser sources are refused; HTTP sources still work. Ego settings live on the worker.
     */
    browserQueue: z.string().min(1).max(200).optional(),
  }),
);
export type BrandScanSettings = z.infer<typeof BrandScanSettingsSchema>;
