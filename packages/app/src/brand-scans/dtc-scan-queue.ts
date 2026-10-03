import { z } from "zod";

export const DtcScanQueueChangeSchema = z.strictObject({
  requestId: z.uuid(),
  mode: z.enum(["paused", "running"]),
});
export const DtcScanQueueStatusSchema = z.object({
  mode: z.enum(["paused", "running"]),
  concurrent: z.literal(1),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  cleanupPending: z.number().int().nonnegative(),
});
export type DtcScanQueueStatus = z.infer<typeof DtcScanQueueStatusSchema>;
export interface DtcScanQueue {
  status(): Promise<DtcScanQueueStatus>;
  change(input: z.infer<typeof DtcScanQueueChangeSchema>): Promise<DtcScanQueueStatus>;
}
