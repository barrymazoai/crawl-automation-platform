import { z } from "zod";

export const StopSweepSettingsSchema = z.strictObject({
  /** Private API tRPC base URL, including /trpc. Required by the resources process. */
  apiUrl: z.url(),
  intervalMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
});
