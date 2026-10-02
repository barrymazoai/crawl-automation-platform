import { ListingScanMetricsSchema } from "@crawl-automation/channels-core";
import { z } from "zod";
import { ScanAdmissionCountsSchema, type QueueAddResult } from "../queue/scan-admission.js";

/** Reader metrics remain intact; channels without reader metrics still report queue admission. */
export const ScanMetricsSchema = ListingScanMetricsSchema.partial().extend(
  ScanAdmissionCountsSchema.partial().shape,
);
export type ScanMetrics = z.infer<typeof ScanMetricsSchema>;

export function scanQueueMetrics(result: QueueAddResult, metrics?: ScanMetrics) {
  return {
    ...metrics,
    added: result.added,
    following: result.following ?? 0,
    recent: result.recent ?? 0,
  };
}
