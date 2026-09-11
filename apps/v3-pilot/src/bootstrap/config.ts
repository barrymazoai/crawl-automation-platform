import { resolve } from "node:path";
import { z } from "zod";
import { QUEUES } from "../contracts/index.js";

const ConfigSchema = z.strictObject({
  role: z.enum(["workflow", "ocr", "handoff", "consume"]),
  address: z
    .string()
    .regex(
      /^(127\.0\.0\.1|localhost):\d{1,5}$/,
      "P0 accepts only an isolated loopback Temporal server",
    ),
  namespace: z.literal("default"),
  evidenceRoot: z.string().min(1),
  concurrency: z.coerce.number().int().min(1).max(8),
  hostId: z.string().min(1).max(80),
});
export type PilotConfig = z.infer<typeof ConfigSchema>;
export function loadConfig(env: NodeJS.ProcessEnv): PilotConfig {
  return ConfigSchema.parse({
    role: env.V3_ROLE ?? "workflow",
    address: env.V3_TEMPORAL_ADDRESS ?? "127.0.0.1:7239",
    namespace: "default",
    evidenceRoot: resolve(env.V3_EVIDENCE_ROOT ?? ".local/evidence"),
    concurrency: env.V3_CONCURRENCY ?? "1",
    hostId: env.V3_HOST_ID ?? "local-p0",
  });
}
export const taskQueue = (config: PilotConfig) => QUEUES[config.role];
