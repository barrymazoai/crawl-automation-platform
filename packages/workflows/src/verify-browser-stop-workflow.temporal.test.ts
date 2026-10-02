import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

let environment: TestWorkflowEnvironment;
let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  bundle = await bundleWorkflowCode({
    workflowsPath: new URL("./verify-browser-stop-workflow.ts", import.meta.url).pathname,
  });
}, 60_000);
afterAll(async () => {
  await environment?.teardown();
});

it("routes the stop activity to the resource host and never retries a failed cleanup", async () => {
  const input = {
    owner: { permitId: `permit-${randomUUID()}`, workflowId: "closed-owner", runId: randomUUID() },
    resourceId: "server2-ego-space-6",
  };
  const verifyBrowserStop = vi.fn(async () => {
    throw new Error("verification unavailable");
  });
  const coordinatorQueue = `coordinator-${randomUUID()}`;
  const coordinator = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: coordinatorQueue,
    workflowBundle: bundle,
  });
  const executor = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: "v3.browser.server2-ego-space-6",
    activities: { verifyBrowserStop },
  });
  await coordinator.runUntil(() =>
    executor.runUntil(async () => {
      await expect(
        environment.client.workflow.execute("VerifyBrowserStopWorkflow", {
          workflowId: randomUUID(),
          taskQueue: coordinatorQueue,
          args: [input],
        }),
      ).rejects.toThrow();
    }),
  );
  expect(verifyBrowserStop).toHaveBeenCalledExactlyOnceWith(input);
}, 30_000);
