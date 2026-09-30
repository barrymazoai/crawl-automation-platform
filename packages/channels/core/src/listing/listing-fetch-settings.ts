import { ScraperApiAccessSchema, ScraperApiOptionChoicesSchema } from "@crawl-automation/platform";
import { CHANNEL_IDS, ScraperApiRouteSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";

/** Listing capture options are independent of product-capture settings. */
export const ListingFetchSettingsSchema = z.strictObject({
  route: ScraperApiRouteSchema.refine((route) => route.responseMode !== "binary", {
    message: "Listing pages are HTML or JSON",
  }),
  scraperApi: ScraperApiAccessSchema,
  channels: z.partialRecord(z.enum(CHANNEL_IDS), ScraperApiOptionChoicesSchema).default({}),
});
