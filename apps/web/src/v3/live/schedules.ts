import { z } from "zod";
import { Id, CreateSchedule, UpdateSchedule, ScheduleView, type Source } from "@crawl-automation/v3-contracts";
import { ApiFailure, request } from "./api";

const fields = { key: Id, brandId: Id, sourceId: Id };
export const ScheduleIntent = z.discriminatedUnion("method", [
  z.strictObject({ ...fields, method: z.literal("POST"), input: CreateSchedule }),
  z.strictObject({ ...fields, method: z.literal("PUT"), input: UpdateSchedule }),
]);
export type ScheduleIntent = z.infer<typeof ScheduleIntent>;
export const scheduleStorageKey = "crawler-v3-live:schedule:v1";
export function readScheduleIntent(storage: Storage) {
  const raw = storage.getItem(scheduleStorageKey);
  return raw === null ? null : ScheduleIntent.parse(JSON.parse(raw));
}
export function prepareScheduleIntent(storage: Storage, source: Source, input: unknown, method: "POST" | "PUT") {
  if (readScheduleIntent(storage)) throw Error("已有待确认的计划请求");
  const intent = ScheduleIntent.parse({ key: crypto.randomUUID(), brandId: source.brandId, sourceId: source.id, method, input });
  storage.setItem(scheduleStorageKey, JSON.stringify(intent));
  return intent;
}
export async function sendScheduleIntent(intent: ScheduleIntent) {
  const result = await request(`/brands/${intent.brandId}/sources/${intent.sourceId}/schedule`, ScheduleView, {
    method: intent.method, body: JSON.stringify(intent.input), headers: { "Content-Type": "application/json", "Idempotency-Key": intent.key },
  }, intent.method === "POST" ? 201 : 200);
  const expectedRevision = intent.method === "POST" ? 1 : intent.input.revision + 1;
  if (result.definition.commandId !== intent.key || result.definition.brandId !== intent.brandId || result.definition.sourceId !== intent.sourceId ||
      result.definition.revision !== expectedRevision || result.definition.sourceRevision !== intent.input.sourceRevision ||
      JSON.stringify(result.definition.rule) !== JSON.stringify(intent.input.rule) || result.paused !== (intent.method === "POST" ? true : intent.input.paused))
    throw new ApiFailure("SCHEDULE_RECEIPT_MISMATCH", true, "计划回执不匹配，请保留原请求并重新读取。");
  return result;
}
