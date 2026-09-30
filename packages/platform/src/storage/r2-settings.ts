import { ObjectKeySchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";

export const R2ScopeSchema = z.strictObject({
  endpoint: z
    .string()
    .regex(/^https:\/\/[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  prefix: ObjectKeySchema.refine((key) => key.includes("/"), "Explicit scoped prefix required"),
  timeoutMs: z.number().int().min(100).max(120000).default(30000),
  // Retained for existing deployment files; this never enables retries.
  retries: z.number().int().min(0).max(5).optional(),
});

export type R2Scope = z.infer<typeof R2ScopeSchema>;
