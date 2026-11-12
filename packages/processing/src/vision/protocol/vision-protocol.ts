import {
  US_FACTS,
  keywordPolicyFormats,
  labelFormatsOfCandidate,
  type LabelFormatId,
  type VisionInput,
} from "@crawl-automation/v3-contracts";
import { visionOutputSchema, visionPrompt, validateVision } from "./legacy-vision.js";
import { decodeLabelImage, labelVisionOutputSchema, labelVisionPrompt } from "./label-vision.js";
import {
  decodeLabelImageV2,
  labelVisionOutputV2Schema,
  labelVisionPromptV2,
} from "./label-vision-v2.js";
import {
  decodeIngredientPresenceAnswer,
  isIngredientPresenceAnswer,
} from "./label-ingredient-presence.js";
import { decodeRetainedRepair, labelVisionRepairPolicyVersion } from "./label-vision-repair.js";
import { decodeTranscriptAnswer, isTranscriptAnswer } from "./label-transcript-answer.js";
import { decodeTooSmallAnswer, isTooSmallAnswer } from "./label-image-size.js";
import { LabelVisionRepairAnswerSchema } from "./label-vision-repair.js";
import { isDeepStrictEqual } from "node:util";

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
 * The task fingerprint pins the model's wire protocol. New caller-authored envelopes name their
 * version and policy explicitly; bare historical answers retain the task's original decoder.
 * A failed label check becomes
 * `VISION.LABEL_<check>`.
 */
export function decodeVisionResult(input: VisionInput, raw: string) {
  if (!input.extractionProtocol) {
    return validateVision(raw);
  }
  const formats = taskFormats(input);
  if (JSON.parse(raw)?.codec === labelVisionRepairPolicyVersion) {
    const envelope = LabelVisionRepairAnswerSchema.parse(JSON.parse(raw));
    const original = decodeLabelAnswer(input.extractionProtocol, envelope.originalRaw, formats);
    const retained = { ...envelope.originalCandidate, ...labelFormatsOfCandidate(formats) };
    if (
      !isDeepStrictEqual(original.candidate, retained) ||
      !isDeepStrictEqual(original.codes, envelope.originalCodes)
    ) {
      throw new Error("Retained repair original does not match the original answer");
    }
    const saved = decodeRetainedRepair(raw, formats);
    if (saved.operationId && saved.operationId !== `${input.operationId}:repair`) {
      throw new Error("Repair operation does not belong to this vision task");
    }
    return saved;
  }
  const decoded = decodeLabelAnswer(input.extractionProtocol, raw, formats);
  const { candidate, status, codes } = decoded;
  const first = codes[0];
  const code = status === "review" && first ? first.replace(/^LABEL\./, "VISION.LABEL_") : null;
  return { candidate, status, code, codes };
}

/**
 * KAN-243: the label formats the task's keyword policy selected for, which some label rules read; the US panel for an
 * input that names no keyword selection.
 */
function taskFormats(input: VisionInput): readonly LabelFormatId[] {
  const policy = (input as { selection?: Partial<VisionInput["selection"]> }).selection?.policy;
  return policy ? keywordPolicyFormats(policy) : [US_FACTS];
}

function decodeLabelAnswer(
  protocol: VisionProtocol,
  raw: string,
  formats: readonly LabelFormatId[],
) {
  if (isTooSmallAnswer(raw)) {
    return decodeTooSmallAnswer(raw);
  }
  if (isIngredientPresenceAnswer(raw)) {
    return decodeIngredientPresenceAnswer(raw, formats);
  }
  if (isTranscriptAnswer(raw)) {
    return decodeTranscriptAnswer(raw);
  }
  return protocol === "label-extraction/2" ? decodeLabelImageV2(raw) : decodeLabelImage(raw);
}
