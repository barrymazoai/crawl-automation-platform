import { isDeepStrictEqual } from "node:util";
import type { ObjectStore } from "@crawl-automation/platform";
import {
  decodeJson,
  OrderedDiagnosticsSchema,
  orderedProgressKey,
  type LabelPlanInput,
  type ProductPlanReader,
} from "@crawl-automation/processing";
import { appErrors } from "../errors.js";
import { unattemptedLabelDiagnostics } from "./label-unattempted-diagnostics.js";

/** Read the exact inspected prefix, or diagnose a zero-attempt no-source Review from its retained plan. */
export async function labelReviewDiagnostics(
  objects: Pick<ObjectStore, "read"> | undefined,
  at: { input: LabelPlanInput; states: unknown[]; code?: string; plans?: ProductPlanReader },
  signal: AbortSignal,
) {
  if (!objects || !at.input.sourcePolicy) {
    return {};
  }
  const key = orderedProgressKey(at.input, at.states);
  const bytes = await objects.read(key, 2 * 1024 * 1024, signal);
  if (!bytes) {
    return unattemptedLabelDiagnostics(at, signal);
  }
  const saved = OrderedDiagnosticsSchema.parse(decodeJson(bytes));
  if (
    !isDeepStrictEqual(saved.request.input, at.input) ||
    orderedProgressKey(saved.request.input, saved.request.states) !== key
  ) {
    throw appErrors.create("PIPELINE.REVIEW_UNVERIFIED", { details: { evidenceKey: key } });
  }
  const known = new Set(saved.outcomes.map((outcome) => outcome.sourceId));
  const remaining = remainingOutcomes(at.states, known);
  return {
    progressEvidenceKey: key,
    outcomes: [...saved.outcomes, ...remaining],
    mergeCodes: saved.codes,
    ...(saved.sourceOutcomes ? { sourceOutcomes: saved.sourceOutcomes } : {}),
    ...(saved.conflicts ? { conflicts: saved.conflicts } : {}),
  };
}

function remainingOutcomes(states: unknown[], known: Set<string>) {
  return states.flatMap((state) => {
    if (!state || typeof state !== "object" || !("id" in state) || known.has(String(state.id))) {
      return [];
    }
    return [
      {
        sourceId: String(state.id),
        status: "not_started",
        code: null,
        codes: [],
        missing: [],
        evidenceKeys: [],
      },
    ];
  });
}
