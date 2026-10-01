import { BrandScanRunnerSettingsSchema } from "@crawl-automation/app";
import { ListingFetchSettingsSchema } from "@crawl-automation/channels-core";
import { BrandScanPermitsSchema, withBrowserScanPermit } from "./browser-scan-permit-settings.js";
import { R2ScopeSchema } from "@crawl-automation/platform";
import { z } from "zod";
import { SwansonBrandScanSettingsSchema } from "@crawl-automation/channel-swanson";

/** The API's brand-scan settings (private config): R2 to archive listing pages, ScraperAPI to fetch them. */
export const BrandScanSettingsSchema = ListingFetchSettingsSchema.extend({
  swanson: SwansonBrandScanSettingsSchema.optional(),
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
   * The browser task queue for Amazon Store pages and Whole Foods. Without it those sources are refused;
   * HTTP sources still work. Store selection and Ego settings live on the worker.
   */
  browserQueue: z.string().min(1).max(200).optional(),
}).transform(withBrowserScanPermit);
export type BrandScanSettings = z.infer<typeof BrandScanSettingsSchema>;
