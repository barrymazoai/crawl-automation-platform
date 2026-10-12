import { isLabelCoreVerdict } from "@crawl-automation/platform/errors/label-core";
import type { SavedEvidenceSource } from "@crawl-automation/v3-contracts";
import { labelFailure } from "./label-errors.js";
import type { OrderedEvidence, OrderedProgress, OrderedState } from "./ordered-model.js";
import type { SourceDiagnostic } from "./ordered-source-outcome.js";

type DiagnosticSource = Pick<SavedEvidenceSource, "kind" | "id">;

/** Preserve the planned medium even when no model task was created for the source. */
export function sourceStateDiagnostic(
  source: DiagnosticSource,
  state: OrderedState | undefined,
  pageHasLabelSection?: boolean,
): SourceDiagnostic {
  const kind = source.kind === "page" ? "page" : source.kind === "pdf-text" ? "text" : "image";
  return {
    sourceId: source.id,
    kind,
    status: state?.status ?? "not_started",
    ...stateReason(source, state, pageHasLabelSection),
  };
}

function stateReason(
  source: DiagnosticSource,
  state: OrderedState | undefined,
  pageHasLabelSection?: boolean,
) {
  if (source.kind === "pdf-text") {
    return { reason: "unsupported_media", detail: "pdf-text" };
  }
  if (!state) {
    return source.kind === "page" && pageHasLabelSection === false
      ? { reason: "skipped", detail: "no_label_section" }
      : { reason: "not_attempted" };
  }
  if (state.status === "not_matched" && state.reason) {
    return { reason: "skipped", detail: state.reason };
  }
  const reasons = {
    registered: "model_result_registered",
    review: "source_review",
    unresolved: "execution_unverified",
    rejected: "source_rejected",
    not_matched: "source_not_matched",
  };
  return { reason: reasons[state.status] };
}

/** A durable parser verdict has no core output to re-read; unknown execution still stops. */
export function readSourceState(
  reading: { request: OrderedProgress; evidence: OrderedEvidence },
  at: { source: SavedEvidenceSource; state: OrderedState },
): boolean {
  const { source, state } = at;
  if (["unresolved", "rejected"].includes(state.status)) {
    reading.evidence.terminal = true;
    reading.evidence.reasons.push({
      progress: 0,
      failure: {
        sourceId: source.id,
        code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
        executionFact: "unknown",
      },
    });
    return true;
  }
  if (state.status !== "not_matched" || !state.reason) {
    return false;
  }
  // Diagnostic-only PDF reason: retain the existing file/source verification path.
  if (
    source.kind === "file-image" &&
    state.reason === "pdf" &&
    reading.request.input.failurePolicy === "source-failure-first/2"
  ) {
    return false;
  }
  if (
    source.kind !== "page" ||
    !reading.request.input.corePolicy ||
    !isLabelCoreVerdict(state.reason)
  ) {
    throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
  }
  reading.evidence.reasons.push({
    progress: 1,
    failure: { sourceId: source.id, code: state.reason, executionFact: "executed" },
  });
  return true;
}
