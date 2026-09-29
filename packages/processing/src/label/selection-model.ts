import type {
  LabelImageCandidate,
  LabelProductManifest,
  SavedEvidenceSource,
} from "@crawl-automation/v3-contracts";
import type { LabelSelection, SourceResolution, SourceState } from "./label-plan-model.js";
import type { LoadedPlan } from "./label-plans.js";

type Source = LabelProductManifest["sources"][number];
type ReviewState = Extract<SourceState, { status: "review" }>;

/** What image-first selection needs to look at: retained files, image answers and Reviews. */
export interface LabelInspection {
  file(source: SavedEvidenceSource, signal: AbortSignal): Promise<boolean>;
  image(source: Source, signal: AbortSignal): Promise<LabelImageCandidate>;
  review(reviewId: string): Promise<unknown>;
  reviewSource?(
    source: SavedEvidenceSource,
    state: ReviewState,
    signal: AbortSignal,
  ): Promise<SourceResolution>;
}

export interface SelectionContext {
  selection: LabelSelection;
  loaded: LoadedPlan;
  states: Map<string, SourceState>;
  order: string[];
  selectedIndex: number;
  signal: AbortSignal;
}

export interface SelectionOutcome {
  sources: Source[];
  skipped: string[];
  decisions: unknown[];
}
