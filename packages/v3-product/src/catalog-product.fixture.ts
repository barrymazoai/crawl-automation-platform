import { GncCatalogProductPolicySchema } from "@crawl-automation/v3-contracts";
import { catalogScope } from "../../v3-contracts/src/catalog.fixture.js";
/** Synthetic provider policy. No network credentials or previous product evidence. */
export function catalogProductPolicy(catalogId = "catalog") {
  const text = { schemaVersion: 1, module: "codex.text", implementationVersion: "codex-text/3", policyVersion: "label-text/2",
    resultSchemaVersion: 3, configFingerprint: "a".repeat(64) };
  const names = ["text", "textReceipts", "vision", "assembly", "collection", "plan", "source", "manifest", "page", "pageText",
    "core", "acquire", "imagePrepare", "ocr", "ocrReceipts", "keywords", "capture", "captureReceipts", "productPlan"];
  return GncCatalogProductPolicySchema.parse({ codec: "gnc-catalog-product-policy/1", catalogId, scope: catalogScope,
    network: { routeId: "fixture", version: "1", mode: "direct", managed: true, egressId: "direct/1" },
    sourceText: { ...text, implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2 },
    ocr: { schemaVersion: 1, module: "ocr.file", implementationVersion: "1", policyVersion: "1", resultSchemaVersion: 2, configFingerprint: "b".repeat(64) },
    sourceVisionConfigFingerprint: "c".repeat(64), text, visionConfigFingerprint: "d".repeat(64), corePolicy: "gnc-label-core/1",
    queues: Object.fromEntries(names.map(name => [name, `test-${name}`])), queue: "test-gnc-stream" });
}
