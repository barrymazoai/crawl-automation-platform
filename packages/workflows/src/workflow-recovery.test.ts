import { expect, it, vi } from "vitest";
import { recordWorkflowRecovery } from "./workflow-recovery.js";
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@temporalio/workflow", () => ({
  log: { warn },
  workflowInfo: () => ({ runId: "workflow-run" }),
}));
it("keeps an Activity's real causal code and error in replay-safe logs", () => {
  const cause = Object.assign(new Error("storage disconnected"), { type: "ARTIFACT.UNAVAILABLE" });
  const error = new Error("Activity failed", { cause });
  recordWorkflowRecovery(error, { sourceId: "source-1" });
  expect(warn).toHaveBeenCalledWith(expect.any(String), {
    runId: "workflow-run",
    sourceId: "source-1",
    code: "ARTIFACT.UNAVAILABLE",
    err: error,
  });
});
