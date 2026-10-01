import { PressDelaySchema } from "@crawl-automation/platform";
import { z } from "zod";
import { WHOLE_FOODS_ORIGIN } from "./whole-foods-address.js";

/** Browser worker settings, validated once at startup. */
export const WholeFoodsScanSettingsSchema = z.strictObject({
  canaryUrl: z
    .url()
    .refine((raw) => {
      const url = new URL(raw);
      return (
        url.origin === WHOLE_FOODS_ORIGIN &&
        url.pathname === "/grocery/search" &&
        !!url.searchParams.get("k")?.trim()
      );
    }, "The canary must be a Whole Foods grocery search")
    .default(`${WHOLE_FOODS_ORIGIN}/grocery/search?k=365+by+Whole+Foods+Market`),
  pressDelayMs: PressDelaySchema.default({ min: 4_000, max: 8_000 }),
});
export type WholeFoodsScanSettings = z.infer<typeof WholeFoodsScanSettingsSchema>;
export const WHOLE_FOODS_SCAN_DEFAULTS = WholeFoodsScanSettingsSchema.parse({});
