import { OcrApiSettingsSchema } from "@crawl-automation/processing";
import { z } from "zod";

/**
 * Settings of the label steps on this machine, read once at startup (the `processing` section of the worker config).
 * Only the roles that need a model or the OCR API require those parts; the others run without them.
 */
export const ProcessingSettingsSchema = z.strictObject({
  /** The storage every result is recorded under (the same one the ledger's records name). */
  storageId: z.string().min(1).max(120),
  /** This machine's name in execution intents. */
  nodeId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  /** Codex settings for the text and vision models; checked by the model clients when a model role starts. */
  codex: z.strictObject({ text: z.json(), vision: z.json() }).optional(),
  /** The OCR API on the Windows machine, reached directly over the private network. */
  ocrApi: OcrApiSettingsSchema.optional(),
});
export type ProcessingSettings = z.infer<typeof ProcessingSettingsSchema>;
