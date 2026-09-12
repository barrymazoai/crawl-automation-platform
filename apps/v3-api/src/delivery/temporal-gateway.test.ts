import { expect, it, vi } from "vitest";
import type { Client } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import { CollectionSubmission } from "@crawl-automation/v3-contracts";
import { TemporalGateway } from "./temporal-gateway.js";
import { workflowInput } from "./identity.js";

const id = "e5b786f7-c661-4e44-bfbc-3438a7db97b9";
const submission = CollectionSubmission.parse({
  requestId: id, workflowId: `v3-collection-${id}`, state: "PENDING_DELIVERY",
  snapshot: { brandId: id, brandName: "Test", sourceId: id, sourceRevision: 1,
    channel: "dtc", region: "US", url: "https://example.test/products" },
  createdAt: "2026-09-12T00:00:00.000Z",
});
function fixture(workflowType = "BrandCollectionWorkflow", status = "RUNNING", result: unknown = null) {
  const target = { clusterId: "isolated-test", namespace: "test", taskQueue: "test", workflowType };
  const start = vi.fn(async (_type: string, _options: Record<string, unknown>) => ({}));
  const getHistory = vi.fn(async (request: { historyEventFilterType?: number }) => ({ history: { events:
    request.historyEventFilterType === 2 ? [{ eventId: "50", eventTime: { seconds: 1789171200 },
      workflowExecutionCompletedEventAttributes: { result: { payloads: [defaultPayloadConverter.toPayload(result)] } } }] :
    [{ workflowExecutionStartedEventAttributes: {
      workflowType: { name: workflowType }, taskQueue: { name: target.taskQueue },
      input: { payloads: [defaultPayloadConverter.toPayload(workflowInput(submission))] },
      firstExecutionRunId: id, originalExecutionRunId: id,
    } }],
  } }));
  const client = {
    workflow: { options: { namespace: "test" }, start,
      getHandle: () => ({ describe: async () => ({ runId: id, status: { name: status } }) }) },
    connection: { withDeadline: async (_deadline: number, run: () => unknown) => run(),
      workflowService: { getWorkflowExecutionHistory: getHistory } },
  } as unknown as Client;
  return { gateway: new TemporalGateway(client, target), start };
}

it("keeps a whole brand alive while products queue and settle, without retries or replacement", async () => {
  const f = fixture();
  await f.gateway.start(submission, workflowInput(submission));
  const options = f.start.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
  expect(options).not.toHaveProperty("workflowExecutionTimeout");
  expect(options).not.toHaveProperty("workflowRunTimeout");
  expect(options).not.toHaveProperty("retry");
  expect(options).toMatchObject({ workflowId: submission.workflowId,
    workflowIdReusePolicy: "REJECT_DUPLICATE", workflowIdConflictPolicy: "FAIL" });
});
it("retains the bounded timeout for non-brand delivery probes", async () => {
  const f = fixture("DeliveryAcceptanceProbe");
  await f.gateway.start(submission, workflowInput(submission));
  expect(f.start.mock.calls[0]?.[1]).toMatchObject({ workflowExecutionTimeout: "30 minutes" });
});
it.each(["TIMED_OUT", "FAILED", "CANCELLED", "TERMINATED"])("does not release a %s brand whose abandoned products may still run", async status => {
  await expect(fixture("BrandCollectionWorkflow", status).gateway.inspect(submission))
    .rejects.toMatchObject({ issue: "UNCONFIRMED_TERMINAL" });
});
it("requires a matching settlement receipt even for a completed brand", async () => {
  await expect(fixture("BrandCollectionWorkflow", "COMPLETED", { settled: true }).gateway.inspect(submission))
    .rejects.toMatchObject({ issue: "UNCONFIRMED_TERMINAL" });
  await expect(fixture("BrandCollectionWorkflow", "COMPLETED", {
    codec: "brand-collection-settled/1", requestId: id, settled: true,
  }).gateway.inspect(submission)).resolves.toMatchObject({ status: "COMPLETED", terminalEventId: "50" });
});
