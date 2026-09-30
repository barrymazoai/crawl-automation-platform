import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { Worker } from "@temporalio/worker";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
async function main() {
  if (!/^barrydeMac-mini(?:\.|$)/.test(hostname())) throw Error("MINI_ONLY");
  const [rootArg, ...paths] = process.argv.slice(2); if (!rootArg || !paths.length || paths.length > 20) throw Error("PATHS_REQUIRED");
  const root = resolve(rootArg), results = [];
  // These files are SDK protobuf toJSON snapshots, not Temporal CLI proto-JSON.
  // Rehydrate through the same SDK's generated type; do not mutate installed protobuf packages.
  const require = createRequire(import.meta.url), sdkRequire = createRequire(require.resolve("@temporalio/worker"));
  const History = sdkRequire("@temporalio/proto").temporal.api.history.v1.History;
  for (const path of paths) {
    const saved = JSON.parse(await readFile(path, "utf8")), history = History.fromObject(saved);
    if (!isDeepStrictEqual(history.toJSON(), saved)) throw Error("HISTORY_ENCODING_MISMATCH");
    await Worker.runReplayHistory({ workflowBundle: { codePath: join(root, "swanson-live/product-workflows.cjs") } }, history);
    results.push({ path, replay: "passed", events: history.events?.length });
  }
  const report = { status: "passed", mode: "read-only history replay; no activities/providers/submissions", results };
  await writeFile(join(root, "replay.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(JSON.stringify({ event: "SWANSON_REPLAY_FAILED", name: error?.name, message: String(error?.message ?? "Unknown").slice(0, 500) })); process.exitCode = 1; });
