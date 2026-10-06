import {
  isOrderedEvidencePolicy,
  type ArtifactRef,
  type LabelProductManifest,
} from "@crawl-automation/v3-contracts";
import { labelFailure } from "./label-errors.js";
import type { LabelPlanInput, SavedManifest } from "./label-plan-model.js";

interface AdmissionPlanReader {
  load(input: LabelPlanInput, signal: AbortSignal): Promise<{ manifest: SavedManifest }>;
}

/** Page admission is inapplicable only when the verified ordered plan has exclusively images. */
export async function manifestAdmission(
  plans: AdmissionPlanReader,
  at: { input: LabelPlanInput; documents: ArtifactRef[] },
  signal: AbortSignal,
): Promise<LabelProductManifest["admission"]> {
  const { input, documents } = at;
  if (!input.admission) {
    return undefined;
  }
  if (documents.length) {
    return { policy: input.admission, comparison: "label-typography/2", documents };
  }
  if (!input.sourcePolicy || !isOrderedEvidencePolicy(input.evidencePolicy)) {
    throw labelFailure("CHANNEL.LABEL_SOURCE_UNVERIFIED");
  }
  const { manifest } = await plans.load(input, signal);
  if (!manifest.sources.length || manifest.sources.some((source) => source.kind !== "file-image")) {
    throw labelFailure("CHANNEL.LABEL_SOURCE_UNVERIFIED");
  }
  // Image answers stay in manifest.sources; they must never masquerade as prepared page documents.
  // A planned page with missing evidence fails above instead of silently dropping admission.
  return undefined;
}
