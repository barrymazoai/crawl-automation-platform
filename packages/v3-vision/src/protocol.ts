import type { VisionInput } from "@crawl-automation/v3-contracts";
import { validateVision } from "./extraction.js";
import { decodeLabelImage, decodeLabelImageV2 } from "./label-extraction.js";

/** Execution and independent evidence inspection must dispatch from the pinned input, never the response shape. */
export function decodeVisionResult(input: VisionInput, raw: string) {
  if (!input.extractionProtocol) return validateVision(raw);
  const { candidate, status, codes } = input.extractionProtocol === "label-extraction/2" ? decodeLabelImageV2(raw) : decodeLabelImage(raw);
  return { candidate, status, code: status === "review" ? codes[0]!.replace(/^LABEL\./, "VISION.LABEL_") : null };
}
