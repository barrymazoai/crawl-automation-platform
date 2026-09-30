import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { planRelease, verifySuccessfulEffect, type ClosedRun } from "./temporal-resource-evidence.js";
import { MemoryObjects } from "../../../packages/v3-results/src/testing.fixture.js";
const payload = (x: unknown) => ({ payloads: [{ metadata: { encoding: Buffer.from("json/plain") }, data: Buffer.from(JSON.stringify(x)) }] });
function fixture() {
  const request = { permitId: "permit-1", workflowId: "workflow-1", runId: randomUUID(), needs: [{ resourceId: "cpu", units: 1 }] };
  const schedule = (type: string, input: unknown) => ({ activityTaskScheduledEventAttributes: { activityType: { name: type }, activityId: type, input: payload(input) } });
  const complete = (id: number, output: unknown) => ({ activityTaskCompletedEventAttributes: { scheduledEventId: id, result: payload(output) } });
  const events = [schedule("reserveResources", request), complete(1, { permitId: request.permitId, status: "granted", reason: "available" }),
    schedule("ocrFile", { operationId: "ocr-1" }), { activityTaskStartedEventAttributes: { scheduledEventId: 3, attempt: 1 } },
    complete(3, { status: "registered" }), schedule("releaseResources", request), { workflowExecutionFailedEventAttributes: {} }].map((e, i) => ({ ...e, eventId: i + 1 }));
  const run: ClosedRun = { workflowId: request.workflowId, runId: request.runId, type: "GncStreamingLabelWorkflow", status: "FAILED", history: { events } };
  return { request, run, events, plan: () => planRelease(request, run, [run.type]) };
}
it("extracts matching grant, completed work and unique explicit release intent", () => {
  const f = fixture(); expect(f.plan()).toMatchObject({ grantId: 2, releaseId: 6, terminalId: 7, effects: [{ activityType: "ocrFile", scheduledEventId: 3, completedEventId: 5 }] });
});
it.each(["RUNNING", "CONTINUED_AS_NEW"])("%s cannot release", status => { const f = fixture(); f.run.status = status; expect(f.plan()).toHaveProperty("reason"); });
it("terminal alone is insufficient without release intent", () => { const f = fixture(); f.events[5] = { eventId: 6 } as any; expect(f.plan()).toEqual({ reason: "NO_UNIQUE_RELEASE_INTENT" }); });
it("incomplete history is quarantined", () => { const f = fixture(); f.events[3]!.eventId = 19; expect(f.plan()).toEqual({ reason: "HISTORY_INCOMPLETE" }); });
it("foreign run is never used", () => { const f = fixture(); f.run.runId = randomUUID(); expect(f.plan).toThrow("IDENTITY_CONFLICT"); });
it("unacknowledged external activity is not inferred from Workflow termination", () => { const f = fixture(); f.events[4] = { eventId: 5 } as any; expect(f.plan()).toEqual({ reason: "EXECUTION_UNCONFIRMED" }); });
it("retried activity may leave original attempt alive", () => { const f = fixture(); (f.events[3] as any).activityTaskStartedEventAttributes.attempt = 2; expect(f.plan()).toEqual({ reason: "EXECUTION_UNCONFIRMED" }); });
it("unsupported workflow is quarantined", () => { const f = fixture(); expect(planRelease(f.request, f.run, [])).toEqual({ reason: "WORKFLOW_UNSUPPORTED" }); });
it("unsupported effect cannot be treated as completion evidence", async () => {
  await expect(verifySuccessfulEffect({ activityId: "a", activityType: "unknown", scheduledEventId: 1, completedEventId: 2, input: {}, output: { status: "success" } }, new MemoryObjects(), AbortSignal.timeout(5000))).rejects.toThrow("EFFECT_UNSUPPORTED");
});
