import { z } from "zod";

/** Global policy for brand discovery only; explicit lists, requeues and revisits bypass it. */
export const ScanAdmissionSettingsSchema = z.strictObject({
  recentScanSkipHours: z.number().int().min(0).max(8_760).default(24),
});
export type ScanAdmissionSettings = z.infer<typeof ScanAdmissionSettingsSchema>;

export const ScanAdmissionCountsSchema = z.strictObject({
  added: z.number().int().nonnegative(),
  following: z.number().int().nonnegative(),
  recent: z.number().int().nonnegative(),
});
export type ScanAdmissionCounts = z.infer<typeof ScanAdmissionCountsSchema>;
export type QueueAddResult = Pick<ScanAdmissionCounts, "added"> &
  Partial<Pick<ScanAdmissionCounts, "following" | "recent">>;
