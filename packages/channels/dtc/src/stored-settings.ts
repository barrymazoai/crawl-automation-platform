import { DtcSiteSettingsSchema } from "./settings.js";
import { dtcSitePolicy, type DtcSitePolicy } from "./site-policy.js";
import { analysisErrors } from "./analysis/errors.js";

/** Merge independently verified brand sources by their own domain, preserving configured sites. */
export function storedDtcSites(
  configured: readonly DtcSitePolicy[],
  rows: readonly unknown[],
): DtcSitePolicy[] {
  const sites = new Map(configured.map((site) => [site.siteKey, site]));
  for (const raw of rows) {
    const setting = DtcSiteSettingsSchema.parse(raw);
    const site = dtcSitePolicy(
      setting.kind === "multi-brand" ? setting : { ...setting, kind: "single-brand" },
    );
    const previous = sites.get(site.siteKey);
    if (!previous) {
      sites.set(site.siteKey, site);
      continue;
    }
    sites.set(site.siteKey, mergeSite(previous, site));
  }
  return [...sites.values()];
}

function mergeSite(previous: DtcSitePolicy, site: DtcSitePolicy): DtcSitePolicy {
  if (previous.platform !== site.platform || site.kind !== "multi-brand") {
    throw analysisErrors.create("DTC.ANALYSIS_UNVERIFIED", {
      details: { domain: site.siteKey, reason: "Stored/configured site policy conflict" },
    });
  }
  const catalogs = new Map(sourceCatalogs(previous).map((brand) => [brand.catalogUrl, brand]));
  for (const brand of site.brands) {
    const existing = catalogs.get(brand.catalogUrl);
    if (existing && previous.kind === "single-brand") {
      continue;
    }
    if (existing && existing.brand.toLowerCase() !== brand.brand.toLowerCase()) {
      throw analysisErrors.create("DTC.ANALYSIS_UNVERIFIED");
    }
    catalogs.set(brand.catalogUrl, brand);
  }
  return {
    ...previous,
    kind: "multi-brand",
    catalogUrl: null,
    ...(previous.kind === "single-brand" ? { legacySite: previous } : {}),
    brands: [...catalogs.values()],
  };
}

function sourceCatalogs(site: DtcSitePolicy) {
  return site.kind === "single-brand" && site.catalogUrl
    ? [{ brand: site.siteKey, catalogUrl: site.catalogUrl }]
    : site.brands;
}
