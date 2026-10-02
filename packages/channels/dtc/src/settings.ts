import { z } from "zod";
import { dtcSitePolicy } from "./site-policy.js";

const siteFields = {
  siteKey: z
    .string()
    .max(253)
    .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/),
  platform: z.enum(["shopify", "woocommerce", "jsonld"]),
};
const catalogAddress = z.url().max(4096);
const brandCatalog = z.strictObject({
  brand: z.string().trim().min(1).max(1000),
  catalogUrl: catalogAddress,
});

function ownCatalog(siteKey: string, catalogUrl: string): boolean {
  if (!URL.canParse(catalogUrl)) {
    return false;
  }
  const url = new URL(catalogUrl);
  return url.origin === `https://${siteKey}` && !url.username && !url.password && !url.hash;
}

const singleBrand = z.strictObject({
  ...siteFields,
  // Existing private configs without kind keep their single-brand meaning.
  kind: z.literal("single-brand").optional(),
  catalogUrl: catalogAddress,
});
const multiBrand = z.strictObject({
  ...siteFields,
  kind: z.literal("multi-brand"),
  brands: z.array(brandCatalog).min(1),
});

/** Shared validation for private settings and browser-verified, persisted source settings. */
export const DtcSiteSettingsSchema = z.union([singleBrand, multiBrand]).superRefine((site, ctx) => {
  const catalogs = site.kind === "multi-brand" ? site.brands : [site];
  if (catalogs.some((entry) => !ownCatalog(site.siteKey, entry.catalogUrl))) {
    ctx.addIssue({ code: "custom", message: "Catalogs must be on the site's HTTPS origin" });
  }
  if (site.kind !== "multi-brand") {
    return;
  }
  const names = site.brands.map((entry) => entry.brand.toLowerCase());
  const urls = site.brands.map((entry) => entry.catalogUrl);
  if (new Set(names).size !== names.length || new Set(urls).size !== urls.length) {
    ctx.addIssue({ code: "custom", message: "Each site needs unique brands and catalog URLs" });
  }
});

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
  return (settings?.sites ?? []).map((site) =>
    dtcSitePolicy(site.kind === "multi-brand" ? site : { ...site, kind: "single-brand" }),
  );
}
