import type { VisionInput } from "@crawl-automation/v3-contracts";
import { visionOutputSchema, visionPrompt, validateVision } from "./legacy-vision.js";
import { decodeLabelImage, labelVisionOutputSchema, labelVisionPrompt } from "./label-vision.js";
import {
  decodeLabelImageV2,
  labelVisionOutputV2Schema,
  labelVisionPromptV2,
} from "./label-vision-v2.js";

export type VisionProtocol = VisionInput["extractionProtocol"];

/** The prompt and answer format a protocol asks the model for. */
export function visionRequest(protocol: VisionProtocol): { prompt: string; outputSchema: object } {
  if (protocol === "label-extraction/2") {
    return { prompt: labelVisionPromptV2, outputSchema: labelVisionOutputV2Schema };
  }
  if (protocol === "label-extraction/1") {
    return { prompt: labelVisionPrompt, outputSchema: labelVisionOutputSchema };
  }
  return { prompt: visionPrompt, outputSchema: visionOutputSchema };
}

/** The Review candidate format of a protocol's answers. */
export const visionCandidateSchema = (protocol: VisionProtocol) =>
  protocol ? "label-extraction/1" : "vision-candidate/1";

/**
 * Decodes an answer under the task's own protocol, never by the answer's shape. A failed label check becomes
 * `VISION.LABEL_<check>`.
 */
export function decodeVisionResult(input: VisionInput, raw: string) {
  if (!input.extractionProtocol) {
    return validateVision(raw);
  }
  const decoded =
    input.extractionProtocol === "label-extraction/2"
      ? decodeLabelImageV2(raw)
      : decodeLabelImage(raw);
  const { candidate, status, codes } = decoded;
  const first = codes[0];
  const code = status === "review" && first ? first.replace(/^LABEL\./, "VISION.LABEL_") : null;
  return { candidate, status, code };
}
