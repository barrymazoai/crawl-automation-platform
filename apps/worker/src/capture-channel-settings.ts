import { COSTCO_HTTP_OPTIONS } from "@crawl-automation/channels-costco";
import { WHOLE_FOODS_HTTP_OPTIONS } from "@crawl-automation/channels-wholefoods";
import { CHANNEL_IDS } from "@crawl-automation/channels-core";
import { ScraperApiOptionChoicesSchema } from "@crawl-automation/platform";
import { z } from "zod";

/** The store cookie is mandatory and fixed; other per-channel choices remain configurable. */
export const CaptureChannelSettingsSchema = z
  .partialRecord(z.enum(CHANNEL_IDS), ScraperApiOptionChoicesSchema)
  .default({})
  .transform((channels) => ({
    ...channels,
    costco: { ...COSTCO_HTTP_OPTIONS, ...channels.costco },
    wholefoods: {
      ...channels.wholefoods,
      headers: { ...channels.wholefoods?.headers, ...WHOLE_FOODS_HTTP_OPTIONS.headers },
    },
  }));

/** Owner 2026-10-24: Amazon asks once more at ultra premium after a verification answer; other channels never. */
export const CaptureChallengeTiersSchema = z
  .partialRecord(z.enum(CHANNEL_IDS), z.enum(["premium", "ultraPremium"]))
  .default({ amazon: "ultraPremium" });
