import type {
  LabelCollectedProduct,
  LabelImageCandidate,
  LabelProductManifest,
  PackagingFacts,
  TextCandidateV3,
  TextRecord,
  VisionRecord,
  labelAgreementFormula,
} from "@crawl-automation/v3-contracts";

/** A label source whose registered original evidence the reader has re-verified. */
export type VerifiedLabelSource = { id: string } & (
  | { kind: "text"; record: TextRecord; candidate: TextCandidateV3; fullText: string }
  | { kind: "image"; record: VisionRecord; candidate: LabelImageCandidate }
);

/** A source that ended in a Review; `verifiedExecuted` when that Review says the model ran. */
export interface MergeFailure {
  id: string;
  code: string;
  verifiedExecuted?: boolean;
  /** Formula presence in a schema-checked text coverage Review; absent means unverified. */
  hasFormula?: boolean;
}

export type Provenance = LabelCollectedProduct["provenance"][number];
export type Source = LabelProductManifest["sources"][number];

/** Everything the merge accumulates while it goes through the sources. */
export interface MergeState {
  manifest: LabelProductManifest;
  sources: Map<string, Source>;
  codes: Set<string>;
  warnings: { id: string; code: string }[];
  counts: Set<string>;
  packaging: PackagingFacts | undefined;
  formula: LabelCollectedProduct["formula"] | null;
  otherIngredients: LabelCollectedProduct["otherIngredients"];
  formulaShape: ReturnType<typeof labelAgreementFormula>;
  otherShape: string[] | null;
}

export const words = (text: string) => text.replace(/\s+/gu, " ").trim();
export const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** A problem of a required source blocks the product; of an optional source it is only a warning. */
export function fail(state: MergeState, id: string, code: string): void {
  if (state.sources.get(id)?.required) {
    state.codes.add(code);
  } else {
    state.warnings.push({ id, code });
  }
}
