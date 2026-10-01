import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import { expect, it } from "vitest";
import { withoutPatches } from "./testing/replay/bundles.js";

it("bundles the browser gate and preserves an executable pre-permit branch", async () => {
  const bundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL("./browser-scan-workflow.ts", import.meta.url)),
  });
  expect(withoutPatches(bundle, ["browser-scan-permit-v1"]).code).not.toBe(bundle.code);
}, 60_000);
