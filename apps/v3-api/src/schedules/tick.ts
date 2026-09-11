import { createHash } from "node:crypto";
import { ScheduleTick, scheduleIdFor, scheduleWorkflowPrefix } from "@crawl-automation/v3-contracts";

// Stable across Activity retry/Workflow replay/reset; never use Run ID or Date.now().
export function tickRequestId(raw: ScheduleTick) {
  const tick = ScheduleTick.parse(raw);
  if (tick.scheduleId !== scheduleIdFor(tick.definition.sourceId) ||
      !tick.workflowId.startsWith(`${scheduleWorkflowPrefix(tick.definition.sourceId)}-`)) throw new Error("Tick identity mismatch");
  const bytes = createHash("sha256").update(JSON.stringify(["v3-schedule-tick-v1", tick.definition.clusterId, tick.namespace, tick.scheduleId, tick.scheduledAt])).digest().subarray(0,16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // RFC 9562 UUID v8, application-defined hash.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
