import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import { artifactBuildId, RoleRegistry, workerProcess } from "@crawl-automation/v3-worker-runtime";
async function main() {
  const entry = fileURLToPath(import.meta.url), bundle = join(dirname(entry), "gnc-workflows.cjs");
  const root = dirname(entry);
  const buildId = await artifactBuildId((await readdir(root)).filter(f => /\.(?:js|cjs)$/.test(f)).sort().map(f => join(root, f)));
  await workerProcess(new RoleRegistry("business", [
    { role: "gnc-workflow", capability: "gnc.workflow", compatibility: "gnc-workflow-v1" },
    { role: "gnc-product-workflow", capability: "gnc.product.workflow", compatibility: "gnc-product-v1" },
    { role: "gnc-catalog-page-workflow", capability: "gnc.catalog.page", compatibility: "gnc-catalog-page-v1" },
  ].map(role => ({ ...role, kind: "workflow" as const, contractVersion: 1, buildId, testOnly: false,
    prepare: async () => ({ kind: "workflow" as const, workflowBundle: { codePath: bundle }, dispose: async () => {} }) }))));
}
main().catch(() => { console.error(JSON.stringify({ event: "GNC_WORKFLOW_STARTUP_REJECTED" })); process.exitCode = 1; });
