import { expect, it } from "vitest";
import { currentBundle } from "./testing/replay/bundles.js";
it("bundles brand enrichment without Node/application dependencies in the workflow isolate", async () => {
  const bundle = await currentBundle();
  expect(bundle.code).toContain("BrandEnrichmentWorkflow");
  expect(bundle.code).toContain("brandOwnershipWrite");
}, 60_000);
