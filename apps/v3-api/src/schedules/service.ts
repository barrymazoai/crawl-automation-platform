import { Client, ScheduleAlreadyRunning, ScheduleNotFoundError, type ScheduleDescription } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import { CreateSchedule, UpdateSchedule, ScheduleDefinition, ScheduleView, scheduleIdFor, scheduleWorkflowPrefix, type DailyRule } from "@crawl-automation/v3-contracts";
import type { z } from "zod";
import { ApiError } from "../errors.js";

type Create = z.infer<typeof CreateSchedule>;
type Update = z.infer<typeof UpdateSchedule>;
export interface ScheduleService {
  get(brandId: string, sourceId: string): Promise<ScheduleView | null>;
  create(brandId: string, sourceId: string, input: Create, key: string): Promise<ScheduleView>;
  update(brandId: string, sourceId: string, input: Update, key: string): Promise<ScheduleView>;
}
const range = (start: number, end = start) => [{ start, end, step: 1 }];
export function calendarSpec(rule: z.infer<typeof DailyRule>) {
  return { structuredCalendar: [{ second: range(0), minute: range(rule.minute), hour: range(rule.hour),
    dayOfMonth: range(1,31), month: range(1,12), year: [], dayOfWeek: range(0,6) }], timezoneName: rule.timezone };
}
const conflict = () => new ApiError(409, "SCHEDULE_CONFLICT", "Schedule changed or is not owned by this deployment; read the actual schedule before editing.");
const validateTimezone = (timezone: string) => {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
  catch { throw new ApiError(400, "INVALID_INPUT", "Unsupported IANA timezone."); }
};
export class TemporalSchedules implements ScheduleService {
  constructor(private readonly client: Client, private readonly target: { clusterId: string; namespace: string; taskQueue: string; activityQueue?: string },
    private readonly sourceExists: (brandId: string, sourceId: string, revision?: number) => Promise<void>) {
    if (target.namespace !== client.workflow.options.namespace) throw Error("Schedule namespace mismatch");
  }
  private async read(brandId: string, sourceId: string) {
    const desc = await this.client.connection.withDeadline(Date.now() + 15000, () => this.client.schedule.getHandle(scheduleIdFor(sourceId)).describe());
    const definition = ScheduleDefinition.parse(desc.action.args?.[0]);
    if (definition.brandId !== brandId || definition.sourceId !== sourceId || definition.clusterId !== this.target.clusterId ||
        desc.action.workflowType !== "ScheduledCollectionIntake" || desc.action.taskQueue !== this.target.taskQueue ||
        definition.activityQueue !== (this.target.activityQueue ?? this.target.taskQueue) ||
        desc.action.workflowId !== scheduleWorkflowPrefix(sourceId) || desc.action.args?.length !== 1 ||
        desc.policies.overlap !== "SKIP" || desc.policies.catchupWindow !== 10000 || !desc.policies.pauseOnFailure)
      throw conflict();
    // Reject out-of-band changes instead of presenting stored args as actual spec.
    const raw = desc.raw.schedule?.spec, expected = calendarSpec(definition.rule);
    if (!raw || raw.timezoneName !== expected.timezoneName || raw.structuredCalendar?.length !== 1 ||
        raw.interval?.length || raw.cronString?.length || raw.calendar?.length || raw.excludeStructuredCalendar?.length ||
        raw.startTime || raw.endTime || raw.jitter) throw conflict();
    const actual = raw.structuredCalendar[0]!;
    for (const field of ["second", "minute", "hour", "dayOfMonth", "month", "year", "dayOfWeek"] as const) {
      const values = (actual[field] ?? []).map(v => [v.start ?? 0, v.end ?? 0, v.step ?? 0]);
      const wanted = expected.structuredCalendar[0]![field].map(v => [v.start,v.end,v.step]);
      if (JSON.stringify(values) !== JSON.stringify(wanted)) throw conflict();
    }
    return { desc, definition };
  }
  private view(desc: ScheduleDescription, definition: ScheduleDefinition) {
    return ScheduleView.parse({ scheduleId: desc.scheduleId, definition, paused: desc.state.paused, overlap: "SKIP",
      catchupWindowMs: 10000, pauseOnFailure: true, nextTimes: desc.info.nextActionTimes.map(d => d.toISOString()),
      actionsTaken: desc.info.numActionsTaken, overlapSkipped: desc.info.numActionsSkippedOverlap, missedCatchup: desc.info.numActionsMissedCatchupWindow });
  }
  async get(brandId: string, sourceId: string) {
    await this.sourceExists(brandId, sourceId);
    try { const { desc, definition } = await this.read(brandId, sourceId); return this.view(desc, definition); }
    catch (e) { if (e instanceof ScheduleNotFoundError) return null; throw e; }
  }
  async create(brandId: string, sourceId: string, raw: Create, key: string) {
    const input = CreateSchedule.parse(raw);
    validateTimezone(input.rule.timezone);
    const definition = ScheduleDefinition.parse({ version: 1, clusterId: this.target.clusterId, brandId, sourceId,
      ...input, revision: 1, commandId: key, activityQueue: this.target.activityQueue ?? this.target.taskQueue });
    // First inspect to recover response loss without revalidating a changed source.
    const existing = await this.get(brandId, sourceId);
    if (existing) {
      if (JSON.stringify(existing.definition) === JSON.stringify(definition) && existing.paused) return existing;
      throw conflict();
    }
    await this.sourceExists(brandId, sourceId, input.sourceRevision);
    try {
      await this.client.connection.withDeadline(Date.now() + 15000, () => this.client.schedule.create({ scheduleId: scheduleIdFor(sourceId),
        spec: { calendars: [{ hour: input.rule.hour, minute: input.rule.minute, second: 0 }], timezone: input.rule.timezone },
        action: { type: "startWorkflow", workflowType: "ScheduledCollectionIntake", workflowId: scheduleWorkflowPrefix(sourceId),
          taskQueue: this.target.taskQueue, args: [definition], retry: { maximumAttempts: 1 }, workflowExecutionTimeout: "1 minute" },
        policies: { overlap: "SKIP", catchupWindow: 10000, pauseOnFailure: true }, state: { paused: true, note: "Created paused by V3; explicit activation required" },
      }));
    } catch (e) { if (!(e instanceof ScheduleAlreadyRunning)) throw e; }
    const result = await this.get(brandId, sourceId);
    if (!result || JSON.stringify(result.definition) !== JSON.stringify(definition) || !result.paused) throw conflict();
    return result;
  }
  async update(brandId: string, sourceId: string, raw: Update, key: string) {
    const input = UpdateSchedule.parse(raw);
    validateTimezone(input.rule.timezone);
    const { desc, definition } = await this.read(brandId, sourceId);
    const next = ScheduleDefinition.parse({ ...definition, sourceRevision: input.sourceRevision, rule: input.rule,
      revision: input.revision + 1, commandId: key });
    if (definition.commandId === key) {
      if (JSON.stringify(definition) === JSON.stringify(next) && desc.state.paused === input.paused) return this.view(desc, definition);
      throw conflict();
    }
    if (definition.revision !== input.revision) throw conflict();
    // A pause must remain possible even when the source changed or was disabled.
    await this.sourceExists(brandId, sourceId, input.paused ? undefined : input.sourceRevision);
    const schedule = desc.raw.schedule;
    if (!schedule?.action?.startWorkflow || !desc.raw.conflictToken?.length) throw conflict();
    const conflictToken = desc.raw.conflictToken, startWorkflow = schedule.action.startWorkflow;
    // SDK 1.23 handle.update() omits conflictToken. Use the public RPC with the
    // Describe token so concurrent operators cannot silently overwrite each other.
    await this.client.connection.withDeadline(Date.now() + 15000, () => this.client.workflowService.updateSchedule({ namespace: this.target.namespace, scheduleId: desc.scheduleId,
      conflictToken, requestId: key, identity: "crawler-v3-schedule-api",
      schedule: { ...schedule, spec: calendarSpec(input.rule), state: { ...schedule.state, paused: input.paused },
        action: { startWorkflow: { ...startWorkflow, input: { payloads: [defaultPayloadConverter.toPayload(next)!] } } } },
    }));
    const result = await this.get(brandId, sourceId);
    if (!result || JSON.stringify(result.definition) !== JSON.stringify(next) || result.paused !== input.paused) throw conflict();
    return result;
  }
}
