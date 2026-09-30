// Test-only child provider. Exercises real Temporal history without websites, OCR or models.
export { CatalogWorkflow, PresenceWorkflow } from "../../../packages/v3-product/src/catalog-workflow.js";
import { condition, defineSignal, setHandler } from "@temporalio/workflow";
export async function CatalogProductWorkflow() {
  let released = false;
  setHandler(defineSignal("release"), () => { released = true; });
  await condition(() => released);
  return { fixture: true, result: "released-after-parent-close" };
}
