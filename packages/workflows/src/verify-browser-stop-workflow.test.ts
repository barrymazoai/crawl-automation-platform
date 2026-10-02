import { expect, it, vi } from "vitest";
import { VerifyBrowserStopWorkflow } from "./verify-browser-stop-workflow.js";

const state = vi.hoisted(() => ({ verify: vi.fn(), proxy: vi.fn() }));
vi.mock("@temporalio/workflow", () => ({ proxyActivities: state.proxy }));

it("uses the exact resource queue and a single bounded cleanup activity", async () => {
  state.proxy.mockReturnValue({ verifyBrowserStop: state.verify });
  const input = {
    owner: { permitId: "permit", workflowId: "owner", runId: "run" },
    resourceId: "server2-ego-space-6",
  };
  await VerifyBrowserStopWorkflow(input);
  expect(state.verify).toHaveBeenCalledExactlyOnceWith(input);
  expect(state.proxy).toHaveBeenCalledWith({
    taskQueue: "v3.browser.server2-ego-space-6",
    startToCloseTimeout: "2 minutes",
    scheduleToCloseTimeout: "3 minutes",
    retry: { maximumAttempts: 1 },
  });
});
