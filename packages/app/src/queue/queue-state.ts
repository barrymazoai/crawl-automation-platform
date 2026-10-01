import { z } from "zod";

export const QueueStateSchema = z.enum([
  "queued",
  "ready",
  "running",
  "following",
  "pending",
  "review",
  "completed",
]);
export type QueueState = z.infer<typeof QueueStateSchema>;
