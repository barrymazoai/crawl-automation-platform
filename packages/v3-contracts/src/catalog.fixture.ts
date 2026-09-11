// Synthetic catalog evidence for isolation/failure tests. Never a live completeness claim.
import { CatalogPageSchema, CatalogScopeSchema, type CatalogPage } from "./catalog.js";
export const catalogScope = CatalogScopeSchema.parse({ brandId: "test-brand", sourceId: "gnc", channel: "gnc", region: "US", rootUrl: "https://www.gnc.com/test-brand/", scopeVersion: "catalog/1" });
export function catalogPage(id: string, index = 0, completion: CatalogPage["completion"] = "complete", listings = ["613701"]): CatalogPage {
  const source = { schemaVersion: 1, artifactId: `page-${index}`, observationId: `obs-${id}`, sourceId: "gnc", listingId: "catalog", variantId: null,
    sha256: "a".repeat(64), byteSize: 1, objectKey: `synthetic/${id}/page-${index}.json`, producer: { operationId: `capture-${id}-${index}`, module: "catalog.fixture", implementationVersion: "test/1" }, kind: "result-json", mediaType: "application/json" };
  return CatalogPageSchema.parse({ codec: "catalog-page/1", input: { catalogId: id, scope: catalogScope, page: index, cursor: index === 0 ? null : `https://www.gnc.com/test-brand/?page=${index}` },
    entries: listings.map(listingId => ({ listingId, variantId: null, url: `https://www.gnc.com/energy/${listingId}.html`, kind: "product" })), source,
    nextCursor: completion === "more" ? `https://www.gnc.com/test-brand/?page=${index + 1}` : null, completion, endEvidence: completion === "complete" ? source : null });
}
