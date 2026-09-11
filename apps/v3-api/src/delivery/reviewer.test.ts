import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CollectionSubmission, type DeliveryReceipt } from "@crawl-automation/v3-contracts";
import { DeliveryReviewer } from "./reviewer.js";
import { InspectionError, type ExecutionProof } from "./port.js";
import { inputHash, workflowInput } from "./identity.js";

function fixture() {
  const id = randomUUID(); const now = new Date().toISOString();
  const submission = CollectionSubmission.parse({ requestId: id, workflowId: `v3-collection-${id}`, state: "PENDING_DELIVERY", createdAt: now,
    snapshot: { brandId: randomUUID(), brandName: "Review fixture", sourceId: randomUUID(), sourceRevision: 1,
      channel: "dtc", region: "US", url: "https://synthetic.example" } });
  const target = { clusterId: "test", namespace: "default", taskQueue: "test", workflowType: "Probe" };
  const receipt: DeliveryReceipt = { requestId: id, target, inputHash: inputHash(workflowInput(submission)), state: "CONFIRMED", runId: randomUUID(),
    observedStatus: "RUNNING", lastIssue: null, terminalEventId: null, intentAt: now, checkedAt: now, closedAt: null };
  const proof: ExecutionProof = { runId: receipt.runId!, inputHash: receipt.inputHash, status: "COMPLETED", continued: false, terminalEventId: "15", closedAt: now };
  const get = vi.fn(async (): Promise<DeliveryReceipt | null> => receipt);
  const inspect = vi.fn(async () => proof);
  const reviewer = new DeliveryReviewer({ get: async () => submission }, { get }, { target, inspect });
  return { id, target, receipt, proof, get, inspect, reviewer };
}
describe("operator review is read-only, never permission to release or re-run", () => {
  it("holds missing intents without even inspecting the remote execution", async () => {
    const f = fixture(); f.get.mockResolvedValue(null);
    expect(await f.reviewer.inspect(f.id)).toMatchObject({ decision: "HOLD", issue: "NO_INTENT", mutatesState: false });
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it("reports matching terminal facts without changing the receipt", async () => {
    const f = fixture(); const before = structuredClone(f.receipt);
    expect(await f.reviewer.inspect(f.id)).toMatchObject({ decision: "READY_FOR_RECONCILIATION", issue: null, mutatesState: false });
    expect(f.receipt).toEqual(before); expect(f.get).toHaveBeenCalledTimes(1);
  });
  it("holds local input/target mismatches without remote I/O", async () => {
    const f = fixture(); f.receipt.inputHash = "0".repeat(64);
    expect(await f.reviewer.inspect(f.id)).toMatchObject({ decision: "HOLD", issue: "LOCAL_IDENTITY_MISMATCH" });
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it("does not erase a previously observed chain violation even with fresh terminal proof", async () => {
    const f = fixture(); f.receipt.lastIssue = "CHAIN_CONTINUED";
    expect(await f.reviewer.inspect(f.id)).toMatchObject({ decision: "HOLD", issue: "CHAIN_CONTINUED" });
    f.inspect.mockRejectedValue(new InspectionError("UNAVAILABLE"));
    expect(await f.reviewer.inspect(f.id)).toMatchObject({ decision: "HOLD", issue: "CHAIN_CONTINUED" });
  });
  it("reports a changed remote run even if local receipt was already closed", async () => {
    const f = fixture(); Object.assign(f.receipt, { state: "CLOSED", observedStatus: "COMPLETED", closedAt: f.proof.closedAt, terminalEventId: "15" });
    f.proof.runId = randomUUID();
    expect(await f.reviewer.inspect(f.id)).toMatchObject({ decision: "HOLD", issue: "RUN_CHANGED" });
    expect(f.receipt.state).toBe("CLOSED");
  });
  it("sanitizes unknown errors and refuses invalid request IDs", async () => {
    const f = fixture(); f.inspect.mockRejectedValue(new Error("secret-canary"));
    const result = await f.reviewer.inspect(f.id);
    expect(result).toMatchObject({ decision: "HOLD", issue: "UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain("secret-canary");
    await expect(f.reviewer.inspect("bad-id")).rejects.toThrow();
  });
});
