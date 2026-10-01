import { PressDelaySchema } from "@crawl-automation/platform";
import { z } from "zod";
import { costcoBrandSearchUrl, costcoBrandSourceUrl } from "./address.js";

export const CostcoScanSettingsSchema = z.strictObject({
  canaryUrl: z
    .url()
    .refine((url) => {
      try {
        costcoBrandSourceUrl(url);
        return true;
      } catch {
        return false;
      }
    }, "The canary must be a category-filtered Costco brand URL")
    .default(
      costcoBrandSearchUrl({
        category: "vitamins-herbals-dietary-supplements",
        brand: "Kirkland Signature",
      }),
    ),
  pressDelayMs: PressDelaySchema.default({ min: 4_000, max: 8_000 }),
});
export type CostcoScanSettings = z.infer<typeof CostcoScanSettingsSchema>;
export const COSTCO_SCAN_DEFAULTS = CostcoScanSettingsSchema.parse({});
