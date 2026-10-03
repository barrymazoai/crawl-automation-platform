import type { DtcGalleryRef } from "@crawl-automation/v3-contracts";
import { GalleryStore } from "./gallery-store.js";
import { prepareGalleryTask } from "./gallery-task.js";
import { finishGallery } from "./gallery-result.js";
export { DtcGalleryImageResultSchema, validateGalleryDecision } from "./gallery-result.js";
/** DTC-only preparation and finalization around the existing gated OCR/model providers. */
export class DtcMixedGallery extends GalleryStore {
  prepare(raw: unknown, signal: AbortSignal) {
    return prepareGalleryTask(this, raw, signal);
  }
  finish(
    input: {
      task: DtcGalleryRef;
      decisions: DtcGalleryRef[];
      selections?: DtcGalleryRef[] | undefined;
    },
    signal: AbortSignal,
  ) {
    return finishGallery(this, input, signal);
  }
}
