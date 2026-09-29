import { isAbsolute } from "node:path";
import { z } from "zod";

const absolutePath = z.string().refine(isAbsolute, "Must be an absolute path");

export const DatabaseConfigSchema = z.strictObject({
  connectionString: z.string().min(1),
  maxConnections: z.number().int().min(1).max(50).default(8),
  statementTimeoutMs: z.number().int().min(100).max(120_000).default(5_000),
});
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

/** Same shape as the existing worker runtime configs, so their files can be reused. */
export const TemporalConfigSchema = z.strictObject({
  address: z.string().min(1),
  namespace: z.string().min(1),
  transport: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("insecure") }),
    z.strictObject({
      mode: z.literal("mtls"),
      serverName: z.string().min(1),
      caFile: absolutePath,
      certFile: absolutePath,
      keyFile: absolutePath,
    }),
  ]),
});
export type TemporalConfig = z.infer<typeof TemporalConfigSchema>;

export const LogConfigSchema = z.strictObject({
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});
export type LogConfig = z.infer<typeof LogConfigSchema>;
