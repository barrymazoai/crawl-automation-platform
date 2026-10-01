import type { ObjectStore } from "@crawl-automation/platform";
import type {
  ArtifactRef,
  LabelProductJoin,
  ReviewRecord,
  TextRecord,
  VisionRecord,
  VisionTask,
} from "@crawl-automation/v3-contracts";
import type { TextSource } from "../text/ports.js";
import type { LabelCorePolicies } from "../text/evidence/label-core-policy.js";
import type { VerifiedLabelSource, MergeFailure } from "../assembly/merge-state.js";

export type RecheckSource = LabelProductJoin["manifest"]["sources"][number];
export interface RecheckFile {
  key: string;
  bytes: Uint8Array;
}
export interface SourceReceipt {
  sourceId: string;
  kind: "registered-result" | "registered-review";
  receiptId: string;
  sha256: string;
}
export interface RecheckedSource {
  entry?: VerifiedLabelSource;
  failure?: MergeFailure;
  files: RecheckFile[];
  receipt: SourceReceipt;
}

/** Deliberately no model, OCR, capture, workflow-start, or result-writing ports. */
export interface SavedAnswerDeps {
  objects: Pick<ObjectStore, "read">;
  reviews: { read(id: string): Promise<ReviewRecord | null> };
  textRecords: { read(id: string): Promise<TextRecord | null> };
  imageRecords: { read(id: string): Promise<VisionRecord | null> };
  text: TextSource;
  labelCores: LabelCorePolicies;
  verifyOcr(task: VisionTask, signal: AbortSignal): Promise<void>;
  storageId: string;
}

export interface RecheckArtifact {
  ref: ArtifactRef;
  bytes: Uint8Array;
}
export const RECHECK_RULES = "retained-label/1";
