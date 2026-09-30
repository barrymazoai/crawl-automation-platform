import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { artifactBuildId, checkedActivity, RoleRegistry, workerProcess } from "@crawl-automation/v3-worker-runtime";

const workflowPath = fileURLToPath(new URL("./workflows.cjs", import.meta.url));
const buildId = await artifactBuildId([fileURLToPath(import.meta.url), workflowPath]);
const shared = { contractVersion: 1, compatibility: "c1", buildId, testOnly: true };
const registry = new RoleRegistry("test", [
  { ...shared, role: "fixture-workflow", kind: "workflow", capability: "fixture.workflow", prepare: async () => ({
    kind: "workflow", workflowBundle: { codePath: workflowPath }, dispose: async () => {},
  }) },
  { ...shared, role: "fixture-echo", kind: "activity", capability: "fixture.echo", prepare: async (config) => ({
    kind: "activity", activities: {
      echo: checkedActivity(z.strictObject({ requestId: z.string().uuid(), delayMs: z.number().int().min(0).max(20_000), fail: z.boolean() }),
        z.strictObject({ requestId: z.string().uuid(), pid: z.number().int(), hostId: z.string() }), async input => {
          console.log(JSON.stringify({ event: "FIXTURE_ACTIVITY_STARTED", requestId: input.requestId, pid: process.pid }));
          await delay(input.delayMs);
          if (input.fail) throw new Error("Synthetic failure, not an OCR provider");
          console.log(JSON.stringify({ event: "FIXTURE_ACTIVITY_FINISHED", requestId: input.requestId, pid: process.pid }));
          return { requestId: input.requestId, pid: process.pid, hostId: config.hostId };
        }),
    },
    dispose: async () => { console.log(JSON.stringify({ event: "FIXTURE_MODULE_DISPOSED", pid: process.pid })); },
  }) },
]);
workerProcess(registry).catch(() => {
  console.error(JSON.stringify({ event: "FIXTURE_STARTUP_REJECTED" })); process.exitCode = 1;
});
