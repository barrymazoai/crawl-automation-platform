import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CatalogDiscoverySchema, CatalogExecutionSchema, CatalogProductBindingSchema, GncCatalogProductPolicySchema,
  type CatalogProductBinding } from "@crawl-automation/v3-contracts";
import type { CatalogDatabase } from "./catalog-ledger.js";

export function buildGncCatalogProduct(rawDiscovery: unknown, rawPolicy: unknown): CatalogProductBinding {
  const d = CatalogDiscoverySchema.parse(rawDiscovery), p = GncCatalogProductPolicySchema.parse(rawPolicy);
  if (d.catalogId !== p.catalogId || !isDeepStrictEqual(d.scope, p.scope)) throw Error("CATALOG.PRODUCT_SCOPE");
  // GNC SKU already identifies the selected variant; family expansion is a separate module.
  if (d.entry.kind !== "product" || d.entry.variantId !== null || !/^\d{6}$/.test(d.entry.listingId))
    throw Error("CATALOG.PRODUCT_UNRESOLVED");
  const key = createHash("sha256").update(JSON.stringify(["gnc-catalog-product/1", d.catalogId, d.discoveryId])).digest("hex");
  const id = (role: string) => `${role}-${key}`;
  const owner = { schemaVersion: 1, requestId: id("request"), observationId: id("observation"), brandId: d.scope.brandId,
    sourceId: d.scope.sourceId, listingId: d.entry.listingId, variantId: null };
  return CatalogProductBindingSchema.parse({ queue: p.queue, ...(p.browserPhase?{browserPhase:true}:{}),input: { start: "capture", queues: p.queues, ...(p.resources ? {resources:p.resources} : {}), input: {
    operationId: id("label"), text: p.text, visionConfigFingerprint: p.visionConfigFingerprint,
    ...(p.corePolicy ? { corePolicy: p.corePolicy } : {}),
    ...(p.evidencePolicy ? { evidencePolicy: p.evidencePolicy } : {}),
    sourcePlan: { operationId: id("plan"), parseVersion: "gnc-product-html/2", text: p.sourceText, ocr: p.ocr,
      visionConfigFingerprint: p.sourceVisionConfigFingerprint, task: { schemaVersion: 1, implementationVersion: "gnc-acquire/1", owner,
        network: p.network, capture: { kind: "product", operationId: id("capture"), requestId: owner.requestId,
          brandId: owner.brandId, sourceId: owner.sourceId, sku: owner.listingId, url: d.entry.url,
          binding: { sessionId: `session-${key.slice(0,48)}`, egressId: p.network.egressId } } } },
  } } });
}

/** Persist intent before returning it to Temporal. Changed settings never silently rewrite an existing operation. */
export class PostgresCatalogProducts {
  constructor(private readonly db: CatalogDatabase) {}
  async prepare(rawDiscovery: unknown, rawExecution: unknown,
    resolve: (discovery: ReturnType<typeof CatalogDiscoverySchema.parse>) => CatalogProductBinding): Promise<CatalogProductBinding> {
    const d = CatalogDiscoverySchema.parse(rawDiscovery), execution = CatalogExecutionSchema.parse(rawExecution);
    if (execution.workflowId !== d.workflowId) throw Error("CATALOG.WORKFLOW_IDENTITY");
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`catalog-product:${d.discoveryId}`]);
      const stored = (await c.query("SELECT record FROM catalog_discovery WHERE discovery_id=$1", [d.discoveryId])).rows[0];
      if (!stored || !isDeepStrictEqual(CatalogDiscoverySchema.parse(stored.record), d)) throw Error("CATALOG.DISCOVERY_UNVERIFIED");
      const binding = CatalogProductBindingSchema.parse(resolve(d)), task = binding.input.input.sourcePlan.task;
      if (d.scope.channel !== "gnc" || d.entry.kind !== "product" || task.capture.kind !== "product" ||
        task.owner.brandId !== d.scope.brandId || task.owner.sourceId !== d.scope.sourceId || task.owner.listingId !== d.entry.listingId ||
        task.owner.variantId !== d.entry.variantId || task.capture.sku !== d.entry.listingId || task.capture.url !== d.entry.url)
        throw Error("CATALOG.PRODUCT_IDENTITY");
      await c.query("INSERT INTO catalog_product_input(discovery_id,record) VALUES($1,$2) ON CONFLICT DO NOTHING", [d.discoveryId, binding]);
      const prior = (await c.query("SELECT record FROM catalog_product_input WHERE discovery_id=$1", [d.discoveryId])).rows[0];
      if (!prior || !isDeepStrictEqual(CatalogProductBindingSchema.parse(prior.record), binding)) throw Error("CATALOG.PRODUCT_INPUT_CONFLICT");
      await c.query("INSERT INTO observation_execution(observation_id,execution) VALUES($1,$2) ON CONFLICT DO NOTHING", [task.owner.observationId, execution]);
      await c.query("COMMIT");
      return binding;
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
}
