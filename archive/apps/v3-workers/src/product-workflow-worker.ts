import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactBuildId, RoleRegistry, workerProcess } from "@crawl-automation/v3-worker-runtime";

async function main() {
  const output = dirname(fileURLToPath(import.meta.url));
  const files = (await readdir(output)).filter(n => n.endsWith(".js") || n === "product-workflows.cjs").sort().map(n => join(output, n));
  const buildId = await artifactBuildId(files);
  await workerProcess(new RoleRegistry("business", [
    { role: "product-images-workflow", capability: "product.images.workflow", compatibility: "product-images-v5" },
    { role: "product-evidence-workflow", capability: "product.evidence.workflow", compatibility: "mixed-product-v1" },
    { role: "product-label-workflow", capability: "product.label.workflow", compatibility: "label-product-v1" },
    { role: "gnc-prepared-label-workflow", capability: "gnc.prepared-label.workflow", compatibility: "gnc-label-v1" },
    { role: "gnc-stream-label-workflow", capability: "gnc.stream-label.workflow", compatibility: "gnc-stream-v1" },
    { role: "gnc-core-stream-workflow", capability: "gnc.stream-label.workflow", compatibility: "gnc-core-v1" },
    { role: "product-saved-workflow", capability: "product.saved.workflow", compatibility: "saved-product-v3" },
    { role: "pdf-text-workflow", capability: "pdf.text.workflow", compatibility: "pdf-text-v1" },
    { role: "catalog-workflow", capability: "catalog.workflow", compatibility: "catalog-v1" },
    { role: "brand-collection-workflow", capability: "brand.collection.workflow", compatibility: "brand-v1" },
    { role: "schedule-intake-workflow", capability: "schedule.intake.workflow", compatibility: "schedule-v1" },
    { role: "catalog-product-workflow", capability: "catalog.product.workflow", compatibility: "catalog-product-v1" },
    { role: "presence-workflow", capability: "presence.workflow", compatibility: "presence-v1" },
    { role: "swanson-brand-workflow", capability: "swanson.control", compatibility: "swanson-live-v1" },
    { role: "swanson-product-workflow", capability: "swanson.product-input", compatibility: "swanson-live-v1" },
    { role: "dtc-brand-workflow", capability: "dtc.control", compatibility: "dtc-live-v2" },
    { role: "dtc-product-workflow", capability: "dtc.product-input", compatibility: "dtc-live-v2" },
    { role: "amazon-brand-workflow", capability: "amazon.control", compatibility: "amazon-live-v1" },
    { role: "amazon-product-workflow", capability: "amazon.product-input", compatibility: "amazon-live-v1" },
    { role: "channel-label-workflow", capability: "channel.saved-label", compatibility: "channel-label-v1" },
  ].map(definition => ({ ...definition, kind: "workflow" as const, contractVersion: 1, buildId, testOnly: false, sessionScoped:true as const,
    prepare: async () => ({ kind: "workflow" as const, workflowBundle: { codePath: join(output, "product-workflows.cjs") }, dispose: async () => {} }) }))));
}
main().catch(() => { console.error(JSON.stringify({ event: "PRODUCT_WORKFLOW_STARTUP_REJECTED" })); process.exitCode = 1; });
