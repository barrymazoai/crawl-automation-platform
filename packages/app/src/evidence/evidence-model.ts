import { ChannelIdSchema, ObjectKeySchema, Sha256Schema } from "@crawl-automation/v3-contracts";
import { z } from "zod";

/** A bucket-level test namespace, separate from the production storage scope. */
export const EvidenceTestPrefixSchema = ObjectKeySchema.refine(
  (key) => key.startsWith("tests/") && key.length <= 200,
  "Evidence must use a tests/ prefix of at most 200 characters",
);

export const EvidenceCaptureInputSchema = z.strictObject({
  channel: ChannelIdSchema,
  url: z.url().max(4096),
  note: z.string().max(2000).optional(),
});
export type EvidenceCaptureInput = z.infer<typeof EvidenceCaptureInputSchema>;

export const EvidenceCaptureResultSchema = z.strictObject({
  key: ObjectKeySchema,
  sha256: Sha256Schema,
  size: z.number().int().positive(),
  capturedAt: z.iso.datetime(),
  finalUrl: z.url(),
  /** HTTP status of the captured page, not a processing outcome. */
  status: z.number().int().min(100).max(599),
});
export type EvidenceCaptureResult = z.infer<typeof EvidenceCaptureResultSchema>;
