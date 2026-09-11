import { z } from "zod";
import { Id } from "./brands.js";
import { CollectionSnapshot } from "./submissions.js";

export const CollectionWorkflowInput = z.strictObject({
  version: z.literal(1),
  requestId: Id,
  snapshot: CollectionSnapshot,
});
export type CollectionWorkflowInput = z.infer<typeof CollectionWorkflowInput>;

export const DeliveryTarget = z.strictObject({
  clusterId: z.string().min(1).max(100),
  namespace: z.string().min(1).max(100),
  taskQueue: z.string().min(1).max(200),
  workflowType: z.string().min(1).max(200),
});
export type DeliveryTarget = z.infer<typeof DeliveryTarget>;
export const ExecutionStatus = z.enum([
  "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT", "CONTINUED_AS_NEW",
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;
export const DeliveryIssue = z.enum([
  "NOT_FOUND", "UNAVAILABLE", "IDENTITY_MISMATCH", "RUN_CHANGED", "CHAIN_CONTINUED", "UNCONFIRMED_TERMINAL",
]);
export type DeliveryIssue = z.infer<typeof DeliveryIssue>;
export const DeliveryReceipt = z.strictObject({
  requestId: Id,
  target: DeliveryTarget,
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["START_UNKNOWN", "CONFIRMED", "CLOSED"]),
  runId: Id.nullable(),
  observedStatus: ExecutionStatus.nullable(),
  lastIssue: DeliveryIssue.nullable(),
  terminalEventId: z.string().regex(/^[1-9][0-9]*$/).nullable(),
  intentAt: z.iso.datetime({ offset: true }),
  checkedAt: z.iso.datetime({ offset: true }).nullable(),
  closedAt: z.iso.datetime({ offset: true }).nullable(),
}).superRefine((value, ctx) => {
  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"];
  const valid = value.state === "CLOSED"
    ? value.runId !== null && value.closedAt !== null && value.terminalEventId !== null && value.lastIssue === null && terminal.includes(value.observedStatus ?? "")
    : value.closedAt === null && value.terminalEventId === null &&
      (value.state === "CONFIRMED" ? value.runId !== null : value.runId === null);
  if (!valid) ctx.addIssue({ code: "custom", path: ["state"], message: "Delivery state lacks matching execution evidence" });
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceipt>;
