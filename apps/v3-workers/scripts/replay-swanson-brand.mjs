import fs from "node:fs/promises";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { hostname } from "node:os";
const [dir] = process.argv.slice(2), root = "/Users/barry/apps/crawlv3-batch-a.UiA4dx";
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.ok(dir?.startsWith(root + "/live/swanson-mainflow-20260910/"));
const require = createRequire(root + "/package.json"), { Worker } = require("@temporalio/worker");
const sdkRequire = createRequire(require.resolve("@temporalio/worker"));
const History = sdkRequire("@temporalio/proto").temporal.api.history.v1.History;
const ready = JSON.parse(await fs.readFile(dir + "/ready.json", "utf8"));
assert.ok(ready.release.startsWith(root + "/release-swanson-mainflow-20260910"));
const report = JSON.parse(await fs.readFile(dir + "/evidence/report.json", "utf8")), results = [], calls = {};
for (const workflow of report.workflows) {
  assert.equal(workflow.status, "COMPLETED");
  const saved = JSON.parse(await fs.readFile(dir + "/evidence/history-" + workflow.runId + ".json", "utf8"));
  const history = History.fromObject(saved);
  assert.ok(isDeepStrictEqual(history.toJSON(), saved));
  // Identity-checking workflows require their real ID; the SDK otherwise supplies "fake".
  await Worker.runReplayHistory({ workflowBundle: { codePath: ready.release + "/product-workflows.cjs" } }, history, workflow.workflowId);
  for (const event of saved.events ?? []) {
    const activity = event.activityTaskScheduledEventAttributes;
    if (activity) calls[activity.activityType.name] = (calls[activity.activityType.name] ?? 0) + 1;
  }
  results.push({ workflowId: workflow.workflowId, runId: workflow.runId, events: history.events.length, replay: "passed" });
}
const out = { results, activitiesScheduled: calls, readOnlyReplay: true };
await fs.writeFile(dir + "/evidence/replay.json", JSON.stringify(out, null, 2), { mode: 0o600 });
console.log(JSON.stringify(out));
