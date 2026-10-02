import { expect, it } from "vitest";
import { currentBundle } from "./testing/replay/bundles.js";
it("bundles the site analysis browser workflow without Node-only imports", async () => {
  const bundle = await currentBundle();
  expect(bundle.code).toContain("SiteAnalysisWorkflow");
  expect(bundle.code).toContain("dtc-site-analysis-v1");
}, 60_000);
