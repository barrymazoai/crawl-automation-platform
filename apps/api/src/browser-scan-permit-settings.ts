import { BrandScanPermitSchema } from "@crawl-automation/app";
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
  dtc: browserPermit("dtc"),
  wholefoods: browserPermit("wholefoods"),
  costco: browserPermit("costco"),
};
const HTTP_WHOLE_FOODS_PERMIT = {
  ...BROWSER_SCAN_PERMITS.wholefoods,
  taskQueue: "v3.pipeline.product.v1",
  // JSON scans must not inherit the browser challenge hold of thirty minutes.
  gapAfterSeconds: 2,
  cooldownSeconds: 60,
  maxWaitSeconds: 120,
};

export const BrandScanPermitsSchema = z
  .partialRecord(z.enum(CHANNEL_IDS), BrandScanPermitSchema)
  .default({})
  .refine(
    (permits) =>
      Object.entries(BROWSER_SCAN_PERMITS).every(([channel, defaults]) => {
        const configured = permits[channel as keyof typeof BROWSER_SCAN_PERMITS];
        return !configured || configured.resourceId === defaults.resourceId;
      }),
    "Paced brand scans must share their channel's global brand-scan resource",
  );

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Pick mode-specific defaults before validation, keeping explicit deployment queue overrides. */
export function withScanPermitDefaults(raw: unknown): unknown {
  const settings = object(raw);
  if (!settings) {
    return raw;
  }
  const permits = object(settings.permits === undefined ? {} : settings.permits);
  if (!permits) {
    return raw;
  }
  const defaults = permitDefaults(settings);
  const merged = { ...permits };
  for (const [channel, permit] of Object.entries(defaults)) {
    const given = permits[channel];
    merged[channel] =
      given === undefined ? permit : object(given) ? { ...permit, ...object(given) } : given;
  }
  return { ...settings, permits: merged };
}

function permitDefaults(settings: Record<string, unknown>) {
  const browserQueue = settings.browserQueue;
  const browser = object(settings.wholefoods)?.brandScanMode === "browser";
  const wholefoods = browser
    ? {
        ...BROWSER_SCAN_PERMITS.wholefoods,
        taskQueue: browserQueue ?? BROWSER_SCAN_PERMITS.wholefoods.taskQueue,
      }
    : HTTP_WHOLE_FOODS_PERMIT;
  const costco = {
    ...BROWSER_SCAN_PERMITS.costco,
    taskQueue: browserQueue ?? BROWSER_SCAN_PERMITS.costco.taskQueue,
  };
  return {
    wholefoods,
    ...(browserQueue || object(settings.permits)?.costco ? { costco } : {}),
  };
}
