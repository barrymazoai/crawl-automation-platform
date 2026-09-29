import type {
  CollectionSubmission,
  DeliveryReceipt,
  DeliveryTarget,
} from "@crawl-automation/v3-contracts";
import { describe, expect, it, vi } from "vitest";
import { DeliveryCoordinator, type DeliveryRoutes } from "./delivery-coordinator.js";
import type { DeliveryJournal, ExecutionProof, WorkflowStarter } from "./ports.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const submission: CollectionSubmission = {
  requestId,
  workflowId: `v3-collection-${requestId}`,
  state: "PENDING_DELIVERY",
  createdAt: "2026-09-29T00:00:00.000Z",
  snapshot: {
    channel: "swanson",
    region: "US",
    url: "https://www.swansonvitamins.com/collections/brand-healthy-origins",
    brandId: "22222222-2222-4222-8222-222222222222",
    brandName: "Healthy Origins",
    sourceId: "33333333-3333-4333-8333-333333333333",
    sourceRevision: 2,
  },
};
const swansonTarget: DeliveryTarget = {
  clusterId: "server2",
  namespace: "crawler-v3",
  taskQueue: "v3.swanson.control",
  workflowType: "BrandCollectionWorkflow",
};
const routes: DeliveryRoutes = {
  clusterId: "server2",
  namespace: "crawler-v3",
  channels: { swanson: swansonTarget },
};

function receipt(state: DeliveryReceipt["state"]): DeliveryReceipt {
  return {
    requestId,
    target: swansonTarget,
    inputHash: "a".repeat(64),
    state,
    runId: null,
    observedStatus: null,
    lastIssue: null,
    terminalEventId: null,
    intentAt: "2026-09-29T00:00:01.000Z",
    checkedAt: null,
    closedAt: null,
  };
}

function setup(intent: { mayStart: boolean; state: DeliveryReceipt["state"] }) {
  const proof: ExecutionProof = {
    runId: "44444444-4444-4444-8444-444444444444",
    inputHash: "a".repeat(64),
    status: "RUNNING",
    continued: false,
    terminalEventId: null,
    closedAt: null,
  };
  const journal: DeliveryJournal = {
    get: vi.fn(async () => null),
    begin: vi.fn(async () => ({ mayStart: intent.mayStart, receipt: receipt(intent.state) })),
    record: vi.fn(async () => receipt("CONFIRMED")),
  };
  const starter: WorkflowStarter = {
    start: vi.fn(async () => undefined),
    inspect: vi.fn(async () => proof),
  };
  const coordinator = new DeliveryCoordinator({
    submissions: { get: async () => submission },
    journal,
    starter,
    routes,
  });
  return { coordinator, journal, starter, proof };
}

describe("DeliveryCoordinator", () => {
  it("starts once when it created the intent, then records the inspection", async () => {
    const { coordinator, journal, starter, proof } = setup({
      mayStart: true,
      state: "START_UNKNOWN",
    });

    await coordinator.reconcile(requestId);

    expect(starter.start).toHaveBeenCalledOnce();
    expect(starter.start).toHaveBeenCalledWith(swansonTarget, submission, expect.anything());
    expect(journal.record).toHaveBeenCalledWith(requestId, proof);
  });

  it("only inspects when another call created the intent", async () => {
    const { coordinator, starter } = setup({ mayStart: false, state: "CONFIRMED" });

    await coordinator.reconcile(requestId);

    expect(starter.start).not.toHaveBeenCalled();
    expect(starter.inspect).toHaveBeenCalledOnce();
  });

  it("does nothing more for a closed delivery", async () => {
    const { coordinator, starter, journal } = setup({ mayStart: false, state: "CLOSED" });

    await coordinator.reconcile(requestId);

    expect(starter.inspect).not.toHaveBeenCalled();
    expect(journal.record).not.toHaveBeenCalled();
  });

  it("inspects after a failed start instead of starting again", async () => {
    const { coordinator, starter } = setup({ mayStart: true, state: "START_UNKNOWN" });
    vi.mocked(starter.start).mockRejectedValueOnce(new Error("already started"));

    await coordinator.reconcile(requestId);

    expect(starter.start).toHaveBeenCalledOnce();
    expect(starter.inspect).toHaveBeenCalledOnce();
  });

  it("refuses a channel without a configured target", async () => {
    const { coordinator } = setup({ mayStart: true, state: "START_UNKNOWN" });
    Object.assign(routes, { channels: {} });

    await expect(coordinator.reconcile(requestId)).rejects.toMatchObject({
      code: "DELIVERY.CHANNEL_NOT_CONFIGURED",
    });
    Object.assign(routes, { channels: { swanson: swansonTarget } });
  });
});
