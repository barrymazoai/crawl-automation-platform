import { isAbsolute } from "node:path";
import { z } from "zod";

export const Token = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const path = z.string().refine(isAbsolute);
export const WorkerConfig = z.strictObject({
  role: Token,
  capability: z.string().regex(/^[a-z][a-z0-9.-]{0,100}$/),
  contractVersion: z.number().int().positive(),
  compatibility: Token,
  expectedBuildId: z.string().regex(/^[a-f0-9]{64}$/),
  hostId: Token,
  namespace: z.string().min(1).max(100),
  address: z.string().regex(/^[a-zA-Z0-9.-]+:[0-9]{1,5}$/).refine(s => Number(s.split(":")[1]) > 0 && Number(s.split(":")[1]) <= 65535),
  transport: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("local") }),
    z.strictObject({ mode: z.literal("mtls"), serverName: z.string().min(1), caFile: path, certFile: path, keyFile: path }),
  ]),
  testSession: Token.optional(),
  queueScope: Token.optional(), // Public session routing; not an arbitrary task queue name.
  concurrency: z.number().int().min(1).max(64).default(1),
  shutdownGraceMs: z.number().int().min(0).max(60_000).default(10_000),
  shutdownForceMs: z.number().int().min(1000).max(120_000).default(20_000),
  startupTimeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
}).superRefine((c, ctx) => {
  if (c.transport.mode === "local" && !["localhost", "127.0.0.1"].includes(c.address.split(":")[0]!))
    ctx.addIssue({ code: "custom", message: "Remote plaintext is forbidden" });
  if (c.shutdownForceMs <= c.shutdownGraceMs) ctx.addIssue({ code: "custom", message: "Shutdown force must exceed grace" });
});
export type WorkerConfig = z.infer<typeof WorkerConfig>;
export function parseWorkerConfig(input: unknown): WorkerConfig {
  const parsed = WorkerConfig.safeParse(input);
  if (!parsed.success) throw new Error("Invalid V3 Worker configuration"); // Never log raw config/credentials.
  return parsed.data;
}
