import { describe, expect, it } from "vitest";
import { CollectionWorkflowInput, DeliveryReceipt } from "./delivery.js";
const id = "e5b786f7-c661-4e44-bfbc-3438a7db97b9";
const pending = {
  requestId: id, target: { clusterId: "test", namespace: "test", taskQueue: "probe", workflowType: "Probe" },
  inputHash: "a".repeat(64), state: "START_UNKNOWN", runId: null, observedStatus: null, lastIssue: "NOT_FOUND",
  terminalEventId: null, intentAt: "2026-09-05T00:00:00.000Z", checkedAt: null, closedAt: null,
};
describe("delivery evidence wire contracts", () => {
  it("allows an explicit unknown result without pretending the task failed or finished", () => {
    expect(DeliveryReceipt.parse(pending)).toEqual(pending);
  });
  it("requires a confirmed run for CONFIRMED and full terminal evidence for CLOSED", () => {
    expect(DeliveryReceipt.safeParse({ ...pending, state: "CONFIRMED" }).success).toBe(false);
    expect(DeliveryReceipt.safeParse({ ...pending, state: "CLOSED" }).success).toBe(false);
    const closed = { ...pending, state: "CLOSED", runId: id, observedStatus: "COMPLETED", lastIssue: null,
      terminalEventId: "11", closedAt: "2026-09-05T00:01:00.000Z" };
    expect(DeliveryReceipt.safeParse(closed).success).toBe(true);
    expect(DeliveryReceipt.safeParse({ ...closed, observedStatus: "CONTINUED_AS_NEW" }).success).toBe(false);
  });
  it("keeps workflow input versioned and rejects embedded delivery/credential fields", () => {
    const input = { version: 1, requestId: id, snapshot: { brandId: id, brandName: "Synthetic", sourceId: id,
      sourceRevision: 2, channel: "dtc", region: "US", url: "https://sample.example/products" } };
    expect(CollectionWorkflowInput.safeParse(input).success).toBe(true);
    expect(CollectionWorkflowInput.safeParse({ ...input, version: 2 }).success).toBe(false);
    expect(CollectionWorkflowInput.safeParse({ ...input, apiToken: "not-allowed" }).success).toBe(false);
  });
});
