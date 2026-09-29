import { BrandScanRunnerSettingsSchema } from "@crawl-automation/app";
import { CHANNEL_IDS } from "@crawl-automation/channels-core";
import { ScraperApiAccessSchema, ScraperApiOptionChoicesSchema } from "@crawl-automation/platform";
import { R2ScopeSchema } from "@crawl-automation/v3-artifacts";
import { ScraperApiRouteSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";

/** The API's brand-scan settings (private config): R2 to archive listing pages, ScraperAPI to fetch them. */
export const BrandScanSettingsSchema = z.strictObject({
  r2: R2ScopeSchema,
  r2Credentials: z.strictObject({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
  }),
  /** The route's name, egress and default options (country, session; `rendered-html` means render). */
  route: ScraperApiRouteSchema.refine((route) => route.responseMode !== "binary", {
    message: "Listing pages are HTML or JSON",
  }),
  scraperApi: ScraperApiAccessSchema,
  /** A channel's own ScraperAPI options over the route's, e.g. `{ "gnc": { "premium": true } }`. */
  channels: z.partialRecord(z.enum(CHANNEL_IDS), ScraperApiOptionChoicesSchema).default({}),
  runner: BrandScanRunnerSettingsSchema.default({
    intervalMs: 5_000,
    concurrent: 4,
    staleMs: 1_800_000,
  }),
  /**
   * The browser machine's task queue (Server 二), where Whole Foods listings are scanned in Ego; absent means Whole
   * Foods is not scanned. This process never drives a browser: the store and Ego settings live on that worker.
   */
  browserQueue: z.string().min(1).max(200).optional(),
});
export type BrandScanSettings = z.infer<typeof BrandScanSettingsSchema>;
