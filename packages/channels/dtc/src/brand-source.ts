import { channelErrors } from "@crawl-automation/channels-core";
import { z } from "zod";
import { dtcIdentityKey } from "./identity.js";
import type { DtcSitePolicy } from "./site-policy.js";
import { dtcEvidenceErrors } from "./evidence-errors.js";

export const DtcBrandSourceSchema = z.strictObject({
  sourceId: z.string().min(1),
  siteKey: z.string().min(1),
  brand: z.string().min(1).max(1000),
  catalogUrl: z.url().max(4096),
});
export type DtcBrandSource = z.infer<typeof DtcBrandSourceSchema>;

/** One task/source per brand on a site, never one combined retailer task. */
export function dtcBrandSources(sites: readonly DtcSitePolicy[]): DtcBrandSource[] {
  return sites.flatMap((site) => {
    const catalogs =
      site.kind === "multi-brand"
        ? site.brands
        : site.catalogUrl
          ? [{ brand: site.siteKey, catalogUrl: site.catalogUrl }]
          : [];
    return catalogs.map((entry) => ({
      ...entry,
      siteKey: site.siteKey,
      sourceId: dtcIdentityKey(site.siteKey, JSON.stringify([entry.brand, entry.catalogUrl])),
    }));
  });
}

/** Exact catalog entry resolution also prevents choosing another brand via a pagination URL. */
export function dtcBrandSource(raw: string, sites: readonly DtcSitePolicy[]): DtcBrandSource {
  const sources = dtcBrandSources(sites).filter((source) => source.catalogUrl === raw);
  if (sources.length !== 1 || !sources[0]) {
    throw channelErrors.create("CHANNEL.URL_REJECTED", { details: { url: raw } });
  }
  return sources[0];
}

/** A database brand cannot claim another configured brand's catalog. Single-brand names stay compatible. */
export function assertDtcBrandSource(
  entry: { url: string; brandName: string },
  sites: readonly DtcSitePolicy[],
): void {
  const source = dtcBrandSource(entry.url, sites);
  const site = sites.find((candidate) => candidate.siteKey === source.siteKey);
  if (site?.legacySite?.catalogUrl === entry.url) {
    return;
  }
  if (site?.kind === "multi-brand" && !sameDtcBrand(source.brand, entry.brandName)) {
    throw dtcEvidenceErrors.create("DTC.BRAND_SOURCE_MISMATCH", {
      details: { configuredBrand: source.brand, brandName: entry.brandName, url: entry.url },
    });
  }
}

export function sameDtcBrand(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
