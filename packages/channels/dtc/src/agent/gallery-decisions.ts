import { z } from "zod";
import {
  DtcGalleryDecisionSchema,
  DtcGalleryRefSchema,
  type DtcGalleryRef,
  type DtcGalleryTask,
} from "@crawl-automation/v3-contracts";
import { GalleryStore } from "./gallery-store.js";
import { GalleryModelOutput } from "./gallery-model-output.js";
import { singleFactsImage } from "./gallery-sharing.js";
export const DtcGalleryImageResultSchema = z.strictObject({
  task: DtcGalleryRefSchema,
  imageId: z.string(),
  decision: DtcGalleryDecisionSchema,
  ocr: DtcGalleryRefSchema,
});

export async function readGalleryResults(
  store: GalleryStore,
  input: { task: DtcGalleryRef; decisions: DtcGalleryRef[] },
  signal: AbortSignal,
) {
  const task = await store.task(input.task, signal);
  const results: z.infer<typeof DtcGalleryImageResultSchema>[] = [];
  for (const ref of input.decisions) {
    const result = DtcGalleryImageResultSchema.parse(await store.read(ref, signal));
    if (JSON.stringify(result.task) !== JSON.stringify(input.task)) {
      throw new Error("DTC.GALLERY_RESULT_OWNER");
    }
    results.push(result);
  }
  if (
    results.length !== task.images.length ||
    new Set(results.map((item) => item.imageId)).size !== results.length ||
    task.images.some(
      (image) => !results.some((result) => result.imageId === image.input.file.artifactId),
    )
  ) {
    throw new Error("DTC.GALLERY_RESULTS_INCOMPLETE");
  }
  for (const result of results) {
    validateGalleryDecision(task, result.decision);
  }
  return results;
}
/** Candidates still require a joint comparison when more than one original is returned. */
export function selectedGalleryImages(
  task: DtcGalleryTask,
  results: z.infer<typeof DtcGalleryImageResultSchema>[],
  variantId: string,
) {
  const shared = singleFactsImage(task, results);
  if (shared && task.websiteVariants.some((variant) => variant.variantId === variantId)) {
    return [shared];
  }
  const facts = results.filter((result) => result.decision.kind === "facts");
  const compareUnassigned =
    facts.length > 1 &&
    facts.every((result) => result.decision.basis === "scope-unassigned") &&
    !results.some((result) => result.decision.kind === "unresolved") &&
    task.websiteVariants.some((variant) => variant.variantId === variantId);
  return task.images.filter((image) =>
    results.some(
      (result) =>
        result.imageId === image.input.file.artifactId &&
        result.decision.kind === "facts" &&
        (compareUnassigned || result.decision.variantIds.includes(variantId)),
    ),
  );
}

export function validateGalleryDecision(task: DtcGalleryTask, raw: unknown) {
  const decision = GalleryModelOutput.parse({ decision: raw }).decision;
  const ids = task.websiteVariants.map((variant) => variant.variantId);
  if (
    new Set(decision.variantIds).size !== decision.variantIds.length ||
    decision.variantIds.some((id) => !ids.includes(id))
  ) {
    throw new Error("DTC.GALLERY_INVENTED_VARIANT");
  }
  if (
    decision.kind === "facts" &&
    (!decision.imageEvidence.trim() || !decision.websiteEvidence.trim())
  ) {
    throw new Error("DTC.GALLERY_SCOPE_UNPROVEN");
  }
  return decision;
}
