import { readFile } from "node:fs/promises";
import { Worker } from "@temporalio/worker";
import { expect, it } from "vitest";
import { currentBundle, withoutPatches } from "./testing/replay/bundles.js";

it("bundles enrichment and can remove its patch for recording pre-enrichment histories", async () => {
  const bundle = await currentBundle();
  expect(bundle.code).toContain("ProductEnrichmentWorkflow");
  expect(bundle.code).toContain("product-enrichment-v1");
  expect(withoutPatches(bundle, ["product-enrichment-v1"]).code).not.toBe(bundle.code);
}, 60_000);

// The owner keeps real histories outside git. Replay is offline; it never starts a Temporal server.
const historyPath = process.env["V3_ENRICHMENT_REPLAY_HISTORY"];
it.skipIf(!historyPath)(
  "replays an existing product pipeline history without enrichment markers",
  async () => {
    const history = JSON.parse(await readFile(historyPath ?? "", "utf8"));
    await Worker.runReplayHistory(
      { workflowBundle: await currentBundle() },
      history,
      process.env["V3_ENRICHMENT_REPLAY_WORKFLOW_ID"] ?? "product-enrichment-replay",
    );
  },
  60_000,
);
