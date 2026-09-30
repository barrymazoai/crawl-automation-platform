import path from "node:path";
import type { AmazonImageEvidence } from "./backfill-image.js";
import type { StoredRawLabelVerdict } from "./label-extraction.js";
import { parseLabel, scoreConfidence } from "./label-parse.js";
import { buildOcrTextLabelPrompt, type IndexedOcrImage } from "./ocr-label-pipeline.js";

export type AmazonFormulaProposal = {
  productId: string;
  status: "ready" | "review";
  reviewReasons: string[];
  panelType: string | null;
  confidence: number | null;
  sourceImages: Array<{ imageId: string; imageIndex: number }>;
  servingSize: number | null;
  servingUnit: string | null;
  servingsPerContainer: number | null;
  rows: ReturnType<typeof parseLabel> extends infer T
    ? T extends { rows: infer R } ? R : never
    : never;
  hash: string | null;
  unreadable: string[];
};

/**
 * Build the Formula prompt from OCR responses only. Deliberately omit URLs, local
 * image paths, product titles and other product metadata from the model input.
 */
export function buildAmazonFormulaPrompt(evidence: AmazonImageEvidence) {
  const images: IndexedOcrImage[] = evidence.factsCandidates.map((candidate) => ({
    index: candidate.imageIndex,
    fileName: `facts-candidate-${candidate.imageIndex}${path.extname(new URL(candidate.imageUrl, "https://invalid.local").pathname) || ".txt"}`,
    response: candidate.response,
  }));
  return `${buildOcrTextLabelPrompt(images)}\nIMPORTANT: Return one object with one string field named payload, and put the requested JSON object serialized exactly inside payload.`;
}

export function buildAmazonFormulaProposal(
  evidence: AmazonImageEvidence,
  verdict: StoredRawLabelVerdict,
): AmazonFormulaProposal {
  const label = verdict.parsed;
  const reasons: string[] = [];
  if (!label) reasons.push("label_json_unparseable");
  if (label?.ambiguous) reasons.push("multiple_formulas_ambiguous");
  if (label?.skip) reasons.push("facts_candidate_classified_skip");
  const parsed = parseLabel(label);
  if (label && !label.ambiguous && !label.skip && !parsed) reasons.push("formula_rows_invalid_or_empty");

  const candidateByIndex = new Map(evidence.factsCandidates.map((candidate) => [candidate.imageIndex, candidate]));
  const factsIndexes = (label?.factsImages ?? []).map(Number).filter(Number.isInteger);
  const sourceImages = [...new Set(factsIndexes)].flatMap((index) => {
    const candidate = candidateByIndex.get(index);
    return candidate ? [{ imageId: candidate.imageId, imageIndex: candidate.imageIndex }] : [];
  });
  if (label && !label.skip && !label.ambiguous && sourceImages.length === 0) reasons.push("facts_image_not_mapped_to_candidate");

  const confidence = label && parsed ? scoreConfidence(label, parsed) : null;
  if (confidence != null && confidence < 70) reasons.push("formula_confidence_below_70");
  const unreadable = (label?.unreadable ?? []).map(String).map((value) => value.trim()).filter(Boolean);
  if (unreadable.length > 0) reasons.push("facts_panel_has_unreadable_content");

  return {
    productId: evidence.productId,
    status: reasons.length === 0 ? "ready" : "review",
    reviewReasons: [...new Set(reasons)],
    panelType: label?.panelType ?? null,
    confidence,
    sourceImages,
    servingSize: parsed?.servingSize ?? null,
    servingUnit: parsed?.servingUnit ?? null,
    servingsPerContainer: parsed?.servingsPerContainer ?? null,
    rows: parsed?.rows ?? [],
    hash: parsed?.hash ?? null,
    unreadable,
  };
}
