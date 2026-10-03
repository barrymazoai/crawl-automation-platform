import { z } from "zod";
import {
  DtcGalleryDecisionSchema,
  DtcGalleryRefSchema,
  type DtcGalleryRef,
  type DtcGalleryTask,
} from "@crawl-automation/v3-contracts";
import { GalleryStore } from "./gallery-store.js";
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
export function selectedGalleryImages(
  task: DtcGalleryTask,
  results: z.infer<typeof DtcGalleryImageResultSchema>[],
  variantId: string,
) {
  return task.images.filter((image) =>
    results.some(
      (result) =>
        result.imageId === image.input.file.artifactId &&
        result.decision.kind === "facts" &&
        result.decision.variantIds.includes(variantId),
    ),
  );
}
export function validateGalleryDecision(task: DtcGalleryTask, raw: unknown) {
  const decision = DtcGalleryDecisionSchema.parse(raw);
  const ids = task.websiteVariants.map((variant) => variant.variantId);
  if (
    new Set(decision.variantIds).size !== decision.variantIds.length ||
    decision.variantIds.some((id) => !ids.includes(id))
  ) {
    throw new Error("DTC.GALLERY_INVENTED_VARIANT");
  }
  if (
    decision.kind === "facts" &&
    (!decision.variantIds.length ||
      !decision.imageEvidence.trim() ||
      !decision.websiteEvidence.trim() ||
      !["label-content", "website-shared"].includes(decision.basis))
  ) {
    throw new Error("DTC.GALLERY_SCOPE_UNPROVEN");
  }
  if (decision.kind !== "facts" && decision.variantIds.length) {
    throw new Error("DTC.GALLERY_SCOPE_UNPROVEN");
  }
  return decision;
}
