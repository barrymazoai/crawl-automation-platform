import { z } from "zod";
import { OcrInputSchema } from "@crawl-automation/v3-contracts";
import type { LabelModels } from "./label-models.js";

const verifiedRequest = z.strictObject({
  input: OcrInputSchema,
  verifiedFailure: z.literal(true),
});

/** Old histories keep their original OCR classification; only patched calls opt into known failure. */
export function runOcrActivity(models: LabelModels, raw: unknown, signal: AbortSignal) {
  const request = verifiedRequest.safeParse(raw);
  return request.success
    ? models.ocrStep(true).run(request.data.input, signal)
    : models.ocrStep(false).run(raw, signal);
}
