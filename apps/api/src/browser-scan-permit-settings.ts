import { BrandScanPermitSchema, type BrandScanPermit } from "@crawl-automation/app";
import { CHANNEL_IDS } from "@crawl-automation/channels-core";
import { z } from "zod";

function browserPermit(channel: string) {
  return {
    taskQueue: `v3.browser.${channel}.v1`,
    resourceQueue: "v3.resources.v1",
    resourceId: `${channel}-brand-scan`,
    gapAfterSeconds: 60,
    cooldownSeconds: 1_800,
  };
}
export const BROWSER_SCAN_PERMITS = {
  wholefoods: browserPermit("wholefoods"),
  costco: browserPermit("costco"),
};

/** Apply channel-specific browser defaults before the generic HTTP permit defaults. */
export const BrandScanPermitsSchema = z
  .preprocess(
    (raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return raw;
      }
      return Object.fromEntries(
        Object.entries(raw).map(([channel, value]) => {
          const defaults = Object.entries(BROWSER_SCAN_PERMITS).find(
            ([key]) => key === channel,
          )?.[1];
          return [
            channel,
            defaults && value && typeof value === "object" ? { ...defaults, ...value } : value,
          ];
        }),
      );
    },
    z.partialRecord(z.enum(CHANNEL_IDS), BrandScanPermitSchema).default({}),
  )
  .refine(
    (permits) =>
      Object.entries(BROWSER_SCAN_PERMITS).every(([channel, defaults]) => {
        const configured = permits[channel as keyof typeof BROWSER_SCAN_PERMITS];
        return !configured || configured.resourceId === defaults.resourceId;
      }),
    "Browser brand scans must share their channel's global brand-scan resource",
  );

/** A shared browser queue always gives both paced channels their own global capacity-one permit. */
export function withBrowserScanPermit<
  Settings extends {
    browserQueue?: string | undefined;
    permits: Partial<Record<(typeof CHANNEL_IDS)[number], BrandScanPermit>>;
  },
>(settings: Settings): Settings {
  if (!settings.browserQueue) {
    return settings;
  }
  const permits = { ...settings.permits };
  for (const [channel, defaults] of Object.entries(BROWSER_SCAN_PERMITS)) {
    const key = channel as keyof typeof BROWSER_SCAN_PERMITS;
    permits[key] ??= BrandScanPermitSchema.parse({ ...defaults, taskQueue: settings.browserQueue });
  }
  return { ...settings, permits };
}
