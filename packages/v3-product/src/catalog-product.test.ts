import { expect, it } from "vitest";
import { CatalogDiscoverySchema, GncCatalogProductPolicySchema } from "@crawl-automation/v3-contracts";
import { catalogPage } from "../../v3-contracts/src/catalog.fixture.js";
import { catalogProductPolicy } from "./catalog-product.fixture.js";
import { buildGncCatalogProduct } from "./catalog-product.js";
function discovery(id = "one", sku = "613701", catalogId = "catalog") {
  const p = catalogPage(catalogId, 0, "unknown", [sku]);
  return CatalogDiscoverySchema.parse({ discoveryId: id, catalogId, scope: p.input.scope, entry: p.entries[0], source: p.source, workflowId: `product-${id}` });
}
it("same discovery produces identical input without clocks, UUIDs or old product input", () => {
  const d = discovery(), p = catalogProductPolicy(), before = structuredClone({ d, p });
  expect(buildGncCatalogProduct(d, p)).toEqual(buildGncCatalogProduct(d, p)); expect({ d, p }).toEqual(before);
});
it("explicit image-first deployment policy reaches the product input without changing legacy defaults", () => {
  const policy = catalogProductPolicy();
  expect(buildGncCatalogProduct(discovery(), policy).input.input.evidencePolicy).toBeUndefined();
  policy.evidencePolicy = "label-image-first/1";
  expect(buildGncCatalogProduct(discovery(), policy).input.input.evidencePolicy).toBe("label-image-first/1");
});
it("different SKU gets separate observations, operations and browser session", () => {
  const a = buildGncCatalogProduct(discovery(), catalogProductPolicy()).input.input;
  const b = buildGncCatalogProduct(discovery("two", "222222"), catalogProductPolicy()).input.input;
  for (const pair of [[a.operationId, b.operationId], [a.sourcePlan.operationId, b.sourcePlan.operationId],
    [a.sourcePlan.task.owner.observationId, b.sourcePlan.task.owner.observationId], [a.sourcePlan.task.capture.operationId, b.sourcePlan.task.capture.operationId],
    [a.sourcePlan.task.capture.binding.sessionId, b.sourcePlan.task.capture.binding.sessionId]]) expect(pair[0]).not.toBe(pair[1]);
  expect(b.sourcePlan.task.owner.listingId).toBe("222222"); expect(b.sourcePlan.task.capture.url).toContain("222222.html");
});
it("new catalog generation cannot reuse the old operation", () => {
  const a = buildGncCatalogProduct(discovery(), catalogProductPolicy());
  const b = buildGncCatalogProduct(discovery("one", "613701", "next"), catalogProductPolicy("next"));
  expect(a.input.input.operationId).not.toBe(b.input.input.operationId);
});
it.each(["brand", "source", "region", "catalog", "scope-version"])("rejects changed %s scope", mode => {
  const d = discovery();
  if (mode === "brand") d.scope.brandId = "other";
  if (mode === "source") d.scope.sourceId = "other";
  if (mode === "region") d.scope.region = "CA";
  if (mode === "catalog") d.catalogId = "other";
  if (mode === "scope-version") d.scope.scopeVersion = "catalog/2";
  expect(() => buildGncCatalogProduct(d, catalogProductPolicy())).toThrow();
});
it.each(["family", "variant", "sku", "foreign-url", "wrong-url"])("rejects unresolved %s identity", mode => {
  const d = discovery();
  if (mode === "family") d.entry.kind = "family";
  if (mode === "variant") d.entry.variantId = "other";
  if (mode === "sku") d.entry.listingId = "family";
  if (mode === "foreign-url") d.entry.url = "https://example.com/613701.html";
  if (mode === "wrong-url") d.entry.url = "https://www.gnc.com/222222.html";
  expect(() => buildGncCatalogProduct(d, catalogProductPolicy())).toThrow();
});
it("policy rejects inherited product identity and missing capture queue", () => {
  const p = catalogProductPolicy();
  expect(GncCatalogProductPolicySchema.safeParse({ ...p, observationId: "old-product" }).success).toBe(false);
  delete p.queues.capture; expect(GncCatalogProductPolicySchema.safeParse(p).success).toBe(false);
});
it("fresh input begins at capture and keeps the selected parsing/core policy", () => {
  const b = buildGncCatalogProduct(discovery(), catalogProductPolicy());
  expect(b.input.start).toBe("capture"); expect(b.input.input.sourcePlan.parseVersion).toBe("gnc-product-html/2");
  expect(b.input.input.corePolicy).toBe("gnc-label-core/1");
  const i = b.input.input; expect(new Set([i.operationId, i.sourcePlan.operationId, i.sourcePlan.task.capture.operationId]).size).toBe(3);
});
