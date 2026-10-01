import { BrandScanPermitSchema, type BrandScanPermit } from "@crawl-automation/app";
import { CHANNEL_IDS } from "@crawl-automation/channels-core";
import { z } from "zod";

const wholefoods = {
  taskQueue: "v3.browser.wholefoods.v1",
  resourceQueue: "v3.resources.v1",
  resourceId: "wholefoods-brand-scan",
  gapAfterSeconds: 60,
  cooldownSeconds: 1_800,
};

/** Apply Whole Foods defaults before the generic permit schema supplies HTTP defaults. */
export const BrandScanPermitsSchema = z
  .preprocess(
    (raw) => {
      if (!raw || typeof raw !== "object" || !("wholefoods" in raw)) {
        return raw;
      }
      const value = raw.wholefoods;
      return value && typeof value === "object"
        ? { ...raw, wholefoods: { ...wholefoods, ...value } }
        : raw;
    },
    z.partialRecord(z.enum(CHANNEL_IDS), BrandScanPermitSchema).default({}),
  )
  .refine(
    (permits) => !permits.wholefoods || permits.wholefoods.resourceId === wholefoods.resourceId,
    "All Whole Foods scans must share wholefoods-brand-scan",
  );

/** A configured browser queue never starts a new Whole Foods scan without its global permit. */
export function withBrowserScanPermit<
  Settings extends {
    browserQueue?: string | undefined;
    permits: Partial<Record<(typeof CHANNEL_IDS)[number], BrandScanPermit>>;
  },
>(settings: Settings): Settings {
  if (!settings.browserQueue || settings.permits.wholefoods) {
    return settings;
  }
  return {
    ...settings,
    permits: {
      ...settings.permits,
      wholefoods: BrandScanPermitSchema.parse({ ...wholefoods, taskQueue: settings.browserQueue }),
    },
  };
}
