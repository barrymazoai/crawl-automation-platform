import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { defaultPayloadConverter } from "@temporalio/common";
import { executionTree, verifyStoppedTree } from "./amazon-queue-temporal.js";
const payload = (x: unknown) => ({ payloads: [defaultPayloadConverter.toPayload(x)] });
function tree() {
  const job = { sessionId: "exact-owned-session" };
  return [{ workflowId: "w", runId: randomUUID(), status: "COMPLETED", type: "AmazonCatalogProductWorkflow", pending: 0, events: [
    { eventId: 1, activityTaskScheduledEventAttributes: { activityType: { name: "captureAmazonProduct" }, input: payload(job) } },
    { eventId: 2, activityTaskScheduledEventAttributes: { activityType: { name: "closeAmazonProductPage" }, input: payload(job) } },
    { eventId: 3, activityTaskCompletedEventAttributes: { scheduledEventId: 2, result: payload({ status: "not-opened", taskId: job.sessionId, targetId: null }) } },
  ] as any[] }];
}
it("only accepts stopped request-mode work with the exact cleanup receipt", () => {
  expect(() => verifyStoppedTree(tree())).not.toThrow();
  for (const field of ["pending", "running", "missing-close", "foreign-close", "browser-close"]) {
    const rows = tree(), n = rows[0]!;
    if (field === "pending") n.pending = 1;
    if (field === "running") n.status = "RUNNING";
    if (field === "missing-close") n.events.pop();
    if (field === "foreign-close") n.events[2].activityTaskCompletedEventAttributes.result = payload({ status: "not-opened", taskId: "other", targetId: null });
    if (field === "browser-close") n.events[2].activityTaskCompletedEventAttributes.result = payload({ status: "closed", taskId: "exact-owned-session", targetId: "tab" });
    expect(() => verifyStoppedTree(rows)).toThrow();
  }
});
it("follows recorded descendants, rejects reset runs and children whose start is uncertain", async () => {
  const root = randomUUID(), child = randomUUID(); let changed = false, unknown = false;
  const events = (id: string) => [{ workflowExecutionStartedEventAttributes: { firstExecutionRunId: id === "root" ? root : child,
    originalExecutionRunId: id === "root" ? root : child, ...(id === "child" ? { parentWorkflowExecution: { workflowId: "root", runId: root } } : {}) } },
    ...(id === "root" ? [{ eventId: 2, startChildWorkflowExecutionInitiatedEventAttributes: {} },
      ...(!unknown ? [{ childWorkflowExecutionStartedEventAttributes: { initiatedEventId: 2, workflowExecution: { workflowId: "child", runId: child } } }] : [])] : [])];
  const cancel = vi.fn(), client = { workflow: { getHandle: (id: string) => ({ cancel,
    describe: async () => ({ runId: changed ? randomUUID() : id === "root" ? root : child, status: { name: "COMPLETED" }, type: "Probe", raw: {} }),
    fetchHistory: async () => ({ events: events(id) }) }) } } as any;
  expect((await executionTree(client, "root", root)).map(n => n.workflowId)).toEqual(["root", "child"]);
  expect(cancel).not.toHaveBeenCalled();
  changed = true; await expect(executionTree(client, "root", root)).rejects.toThrow("RUN_CHANGED");
  changed = false; unknown = true; await expect(executionTree(client, "root", root)).rejects.toThrow("CHILD_START_UNKNOWN");
});
