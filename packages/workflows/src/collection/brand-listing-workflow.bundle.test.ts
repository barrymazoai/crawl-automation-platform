import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import { expect, it } from "vitest";
import { withoutPatches } from "../testing/replay/bundles.js";

it("bundles listing pacing and can record the pre-gap command sequence", async () => {
  const bundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL("./brand-listing-workflow.ts", import.meta.url)),
  });
  const legacy = withoutPatches(bundle, ["brand-listing-gap-v1", "brand-listing-cooldown-v1"]);
  expect(bundle.code).toContain("brand-listing-gap-v1");
  expect(bundle.code).toContain("brand-listing-cooldown-v1");
  expect(legacy.code).not.toBe(bundle.code);
}, 60_000);
