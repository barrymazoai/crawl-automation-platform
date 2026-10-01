import { readFile } from "node:fs/promises";
import { Worker } from "@temporalio/worker";
import { expect, it } from "vitest";
import { currentBundle, labelPageVerdictMarker } from "../testing/replay/bundles.js";

// Histories are private data, supplied outside git. Replay itself needs no Temporal server.
const path = process.env["CRAWLER_LABEL_REPLAY_HISTORY"];
it.skipIf(!path)(
  "replays an existing pre-source-order LabelWorkflow history unchanged",
  async () => {
    const history = JSON.parse(await readFile(path ?? "", "utf8"));
    expect(JSON.stringify(history)).not.toContain("label-source-order-v1");
    const bundle = await currentBundle();
    await Worker.runReplayHistory({ workflowBundle: bundle }, history);
  },
  60_000,
);

// Private production histories remain outside git; the main session can supply the affected run.
const historyPath = process.env["CRAWLER_LABEL_PAGE_VERDICT_REPLAY_HISTORY"];
it.skipIf(!historyPath)(
  "replays an existing ordered history without the new marker",
  async () => {
    const history = JSON.parse(await readFile(historyPath ?? "", "utf8"));
    expect(JSON.stringify(history)).toContain("label-source-order-v1");
    expect(JSON.stringify(history)).not.toContain(labelPageVerdictMarker);
    await Worker.runReplayHistory({ workflowBundle: await currentBundle() }, history);
  },
  60_000,
);
