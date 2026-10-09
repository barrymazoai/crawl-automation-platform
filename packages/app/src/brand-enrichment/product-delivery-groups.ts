import type { ProductDeliveryCatalog } from "./task-ports.js";
import { domainOf } from "./run-records.js";
import { brandEnrichmentErrors } from "./errors.js";

/** Resolve every requested source before delivery; a missing catalog never falls back to the brand URL. */
export function productDeliveryGroups(sourceIds: string[], catalogs: ProductDeliveryCatalog[]) {
  const groups = new Map<string, string[]>();
  for (const sourceId of sourceIds) {
    const sources = catalogs.filter((catalog) => catalog.sourceId === sourceId);
    const siteKey = sources.length === 1 ? domainOf(sources[0]?.catalogUrl) : null;
    if (!siteKey) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.IDENTITY_UNRESOLVED", {
        details: { sourceId, reason: "Missing or ambiguous DTC source catalog" },
      });
    }
    const group = groups.get(siteKey) ?? [];
    group.push(sourceId);
    groups.set(siteKey, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([siteKey, sources]) => ({ siteKey, sourceIds: sources.sort() }));
}
