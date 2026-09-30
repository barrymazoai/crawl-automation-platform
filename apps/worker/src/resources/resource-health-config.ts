import { isAbsolute } from "node:path";
import { OcrApiSettingsSchema } from "@crawl-automation/processing";
import { z } from "zod";

/** A monitor may refresh only these rows, under exactly the configured controller string. */
export const ResourceHealthConfigSchema = z
  .strictObject({
    controller: z.string().min(1),
    intervalMs: z.number().int().min(1).max(2_147_483_647).default(5_000),
    ttlMs: z.number().int().positive().default(15_000),
    minFreeBytes: z.number().int().nonnegative(),
    diskPath: z.string().refine(isAbsolute, "Must be an absolute path"),
    ocrApi: z.looseObject({ baseUrl: z.url() }).pipe(OcrApiSettingsSchema).optional(),
    resources: z.record(
      z.string().min(1),
      z.strictObject({
        taskQueues: z.array(z.string().min(1).max(200)).min(1),
        ocr: z.boolean().optional(),
      }),
    ),
  })
  .refine((config) => config.ttlMs > config.intervalMs, "TTL must exceed the refresh interval")
  .refine(
    (config) => config.ocrApi || !Object.values(config.resources).some((target) => target.ocr),
    "Resources requiring OCR must configure ocrApi",
  );
