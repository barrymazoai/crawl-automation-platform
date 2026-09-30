import { z } from "zod";
import { dtcSitePolicy } from "./site-policy.js";

/** Only browser-verified sites are enabled; no platform or catalog is inferred at startup. */
export const DtcSiteSettingsSchema = z
  .strictObject({
    siteKey: z
      .string()
      .max(253)
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/),
    platform: z.enum(["shopify", "woocommerce", "jsonld"]),
    catalogUrl: z.url().max(4096),
  })
  .refine(
    ({ siteKey, catalogUrl }) => {
      if (!URL.canParse(catalogUrl)) {
        return false;
      }
      const url = new URL(catalogUrl);
      return url.origin === `https://${siteKey}` && !url.username && !url.password && !url.hash;
    },
    { message: "Catalog must be on the site's HTTPS origin, without credentials or a fragment" },
  );

export const DtcSettingsSchema = z.strictObject({
  sites: z
    .array(DtcSiteSettingsSchema)
    .refine((sites) => new Set(sites.map((site) => site.siteKey)).size === sites.length, {
      message: "DTC site keys must be unique",
    })
    .default([]),
});

/** Shared by the API and worker so addresses, capture and planning use the same site policies. */
export function configuredDtcSites(settings?: z.infer<typeof DtcSettingsSchema>) {
  return (settings?.sites ?? []).map((site) => dtcSitePolicy(site));
}
