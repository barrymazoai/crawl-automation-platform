import { ScraperApiAccessSchema, ScraperApiOptionChoicesSchema } from "@crawl-automation/platform";
import { CHANNEL_IDS, ScraperApiRouteSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";

const ListingChannelSettingsSchema = ScraperApiOptionChoicesSchema.extend({
  /** Pause between pages of one scan; Node timers require a signed 32-bit millisecond delay. */
  requestIntervalMs: z.number().int().min(0).max(2_147_483_647).default(0),
});
export type ListingChannelSettings = z.input<typeof ListingChannelSettingsSchema>;

/** Listing capture options are independent of product-capture settings. */
export const ListingFetchSettingsSchema = z.strictObject({
  route: ScraperApiRouteSchema.refine((route) => route.responseMode !== "binary", {
    message: "Listing pages are HTML or JSON",
  }),
  scraperApi: ScraperApiAccessSchema,
  channels: z.partialRecord(z.enum(CHANNEL_IDS), ListingChannelSettingsSchema).default({}),
});
