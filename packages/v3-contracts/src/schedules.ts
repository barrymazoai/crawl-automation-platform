import { z } from "zod";
import { Id } from "./brands.js";

export const DailyRule = z.strictObject({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  // Workflow-safe structural schema. Runtime validates the actual IANA zone.
  timezone: z.string().min(1).max(100).regex(/^[A-Za-z0-9_+\/-]+$/),
});
export const CreateSchedule = z.strictObject({ rule: DailyRule, sourceRevision: z.number().int().positive() });
export const UpdateSchedule = CreateSchedule.extend({ revision: z.number().int().positive(), paused: z.boolean() });
export const ScheduleDefinition = z.strictObject({
  version: z.literal(1), clusterId: z.string().min(1).max(100), brandId: Id, sourceId: Id, sourceRevision: z.number().int().positive(),
  revision: z.number().int().positive(), commandId: Id, rule: DailyRule,
  activityQueue: z.string().min(1).max(200),
});
export type ScheduleDefinition = z.infer<typeof ScheduleDefinition>;
export const ScheduleView = z.strictObject({
  scheduleId: z.string().regex(/^v3-source-[a-f0-9-]{36}$/), definition: ScheduleDefinition,
  paused: z.boolean(), overlap: z.literal("SKIP"), catchupWindowMs: z.literal(10000), pauseOnFailure: z.literal(true),
  nextTimes: z.array(z.iso.datetime()), actionsTaken: z.number().int().nonnegative(),
  overlapSkipped: z.number().int().nonnegative(), missedCatchup: z.number().int().nonnegative(),
});
export type ScheduleView = z.infer<typeof ScheduleView>;
export const ScheduleReadback = z.strictObject({ enabled: z.boolean(), item: ScheduleView.nullable() });
export const ScheduleTick = z.strictObject({
  definition: ScheduleDefinition, namespace: z.string().min(1).max(100),
  scheduleId: z.string().regex(/^v3-source-[a-f0-9-]{36}$/),
  workflowId: z.string().min(1).max(250), scheduledAt: z.iso.datetime(),
});
export type ScheduleTick = z.infer<typeof ScheduleTick>;
export const ScheduleTickResult = z.strictObject({
  requestId: Id, state: z.enum(["ACCEPTED", "SKIPPED", "REVIEW"]),
  reason: z.enum(["SOURCE_BUSY", "SOURCE_DISABLED", "REVISION_CONFLICT", "SOURCE_NOT_FOUND"]).nullable(),
}).refine(v => v.state === "ACCEPTED" ? v.reason === null : v.reason !== null);
export type ScheduleTickResult = z.infer<typeof ScheduleTickResult>;
export const scheduleIdFor = (sourceId: string) => `v3-source-${Id.parse(sourceId)}`;
export const scheduleWorkflowPrefix = (sourceId: string) => `v3-tick-${Id.parse(sourceId)}`;
