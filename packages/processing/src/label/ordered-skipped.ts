import { imageReviewWithoutLabel } from "../assembly/source-without-label.js";
import { variantPanelIds, type PanelImage } from "../assembly/variant-panels.js";
import type { OrderedProgress } from "./ordered-model.js";
import type { DiagnosedOrderedEvidence } from "./ordered-source-outcome.js";

/** Sources the merge leaves out: images without a label, and later panels of the first one's formula. */
export function skippedSources(request: OrderedProgress, evidence: DiagnosedOrderedEvidence) {
  const withoutLabel = noLabelSources(evidence);
  const variants = variantPanelIds(
    request.input.evidencePolicy,
    panelImages(request, evidence, withoutLabel),
  );
  return { withoutLabel, variants, skipped: new Set([...withoutLabel, ...variants]) };
}

function panelImages(
  request: OrderedProgress,
  evidence: DiagnosedOrderedEvidence,
  withoutLabel: Set<string>,
): PanelImage[] {
  return request.states.flatMap((state) => {
    const entry = evidence.entries.find((item) => item.id === state.id);
    const candidate = entry
      ? entry.kind === "image"
        ? entry.candidate
        : undefined
      : evidence.failures.find((failure) => failure.id === state.id)?.candidate;
    return candidate && !withoutLabel.has(state.id) ? [{ id: state.id, candidate }] : [];
  });
}

export function noLabelSources(evidence: DiagnosedOrderedEvidence) {
  const ids = evidence.failures.filter(imageReviewWithoutLabel).map((failure) => failure.id);
  for (const diagnostic of evidence.sourceDiagnostics ?? []) {
    if (diagnostic.status === "review" && diagnostic.reason === "model_no_label") {
      ids.push(diagnostic.sourceId);
    }
  }
  return new Set(ids);
}
