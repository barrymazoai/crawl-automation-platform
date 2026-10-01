import type { ObjectStore } from "@crawl-automation/platform";
import type { LabelCollectedProduct } from "@crawl-automation/v3-contracts";
import type { SavedLabelRecheck } from "@crawl-automation/processing";
import type { ReviewStore } from "./review-ports.js";
import type { RecoveryItem, RecoveryOutcome, RecoveryPreview } from "./recovery-model.js";

export interface RecoveryLedger {
  savePreview(preview: RecoveryPreview): Promise<void>;
  readPreview(previewId: string): Promise<RecoveryPreview | null>;
  status(reviewId: string): Promise<RecoveryOutcome | null>;
  collectionFor(observationId: string): Promise<LabelCollectedProduct | null>;
  /** Atomically registers the recovery receipt and collection, preserving the original Review. */
  record(input: {
    previewId: string;
    item: RecoveryItem;
    collection: LabelCollectedProduct | null;
  }): Promise<RecoveryOutcome>;
}

export interface ReviewRecoveryDeps {
  reviews: ReviewStore;
  recheck: Pick<SavedLabelRecheck, "check">;
  ledger: RecoveryLedger;
  objects: ObjectStore;
}
