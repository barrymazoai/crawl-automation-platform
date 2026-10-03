import { z } from "zod";
import { DtcGalleryRefSchema, ExecutionIdSchema } from "@crawl-automation/v3-contracts";

export const GallerySelectionDecision = z.strictObject({
  selectedImageId: ExecutionIdSchema.nullable(),
  reason: z.string().min(1).max(8000),
  comparisonEvidence: z.string().min(1).max(24000),
});
export const GallerySelectionProof = z.strictObject({
  task: DtcGalleryRefSchema,
  variantId: ExecutionIdSchema,
  candidateImageIds: z.array(ExecutionIdSchema).min(2).max(100),
  decision: GallerySelectionDecision,
});
export type GallerySelection = z.infer<typeof GallerySelectionProof>;

export function verifyGallerySelection(
  proof: GallerySelection,
  expected: Omit<GallerySelection, "decision">,
) {
  if (
    JSON.stringify({ ...proof, decision: undefined }) !== JSON.stringify(expected) ||
    (proof.decision.selectedImageId !== null &&
      !expected.candidateImageIds.includes(proof.decision.selectedImageId))
  ) {
    throw new Error("DTC.GALLERY_SELECTION_OWNER");
  }
  return proof;
}
