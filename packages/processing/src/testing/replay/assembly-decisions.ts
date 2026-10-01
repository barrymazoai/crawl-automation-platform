import { strict as assert } from "node:assert";
import { z } from "zod";
import {
  LabelProductJoinSchema,
  LabelProductProvenanceSchema,
  TextCandidateV3Schema,
} from "@crawl-automation/v3-contracts";
import { beginMerge, verifiedProvenance } from "../../assembly/merge-sources.js";
import { mergePolicy, applyFailures, applyPackagingIssues } from "../../assembly/merge-policy.js";
import { selectLabel } from "../../assembly/merge-selection.js";
import type {
  LabelEvidence,
  MergeFailure,
  VerifiedLabelSource,
  MergeState,
  Source,
} from "../../assembly/merge-state.js";
import { sourceReviewFailure } from "../../assembly/source-review.js";
import { visionTaskFingerprint } from "../../vision/vision-files.js";
import { documentText, type SavedEvidence } from "./saved-evidence.js";
import type { ReplayedText } from "./text-answers.js";

const AssemblySchema = z.object({
  input: LabelProductJoinSchema,
  result: z.object({
    codes: z.array(z.string()),
    provenance: z.array(LabelProductProvenanceSchema),
  }),
});
type SavedAssembly = z.infer<typeof AssemblySchema>;
export interface DecisionReplay {
  reviewId: string;
  runId: string;
  before: string[];
  after: string[];
  promoted: number;
}

/** Counterfactual decisions only: no receipt fabrication, registration, pixel verification or collection. */
export async function replayAssemblies(data: SavedEvidence, answers: Map<string, ReplayedText>) {
  const decisions: DecisionReplay[] = [];
  for (const review of data.records.values()) {
    if (!review.candidate?.schema.startsWith("label-product-assembly/")) {
      continue;
    }
    const saved = AssemblySchema.parse(review.candidate.value);
    const entries = savedEntries(data, saved);
    const inputs = await changedInputs({ data, answers, saved });
    const manifest = { ...saved.input.manifest, evidencePolicy: "label-image-first/6" as const };
    const state = beginMerge(manifest, undefined);
    const uniqueFailures = [
      ...new Map(inputs.failures.map((failure) => [failure.id, failure])).values(),
    ];
    const verified = verifiedProvenance(state, entries, uniqueFailures);
    const sources: LabelEvidence[] = [...verified.provenance, ...inputs.promoted];
    const seen = new Set([...verified.seen, ...inputs.promoted.map((entry) => entry.id)]);
    if (seen.size !== manifest.sources.length) {
      state.codes.add("LABEL_PRODUCT.EVIDENCE_UNRESOLVED");
    }
    const policy = mergePolicy(state, sources);
    applyFailures(state, inputs.failures, policy);
    applyPackagingIssues(state, policy);
    selectLabel(state, sources, policy);
    const after = finalCodes(state);
    decisions.push({
      reviewId: review.reviewId,
      runId: review.failure.requestId,
      before: saved.result.codes,
      after,
      promoted: inputs.promoted.length,
    });
  }
  return decisions;
}

function savedEntries(data: SavedEvidence, saved: SavedAssembly): VerifiedLabelSource[] {
  return saved.result.provenance.flatMap((entry): VerifiedLabelSource[] => {
    if (entry.kind === "text") {
      return [{ ...entry, fullText: documentText(data, entry.record.input) }];
    }
    return entry.record.codec === "vision-reviewed/1" ? [] : [{ ...entry, record: entry.record }];
  });
}

async function changedInputs(at: {
  data: SavedEvidence;
  answers: Map<string, ReplayedText>;
  saved: SavedAssembly;
}) {
  const failures: MergeFailure[] = [];
  const promoted: LabelEvidence[] = [];
  const { data, answers, saved } = at;
  const deps = {
    reviews: { read: async (reviewId: string) => data.records.get(reviewId) ?? null },
    visionFingerprint: visionTaskFingerprint,
  };
  for (const status of saved.input.states) {
    if (status.status !== "review") {
      continue;
    }
    const source = saved.input.manifest.sources.find((entry) => entry.id === status.id);
    assert.ok(source);
    const failure = await sourceReviewFailure(deps, source, {
      input: saved.input,
      reviewId: status.reviewId,
    });
    retainReviewed(saved, failure);
    const answer = answers.get(status.reviewId);
    const promotedText = promoteAnswer(source, answer, failure);
    if (promotedText) {
      promoted.push(promotedText);
    } else {
      const codes = answer?.decoded?.codes;
      failures.push(
        ...(codes?.length
          ? codes.map((code) => ({ ...failure, code: code.replace("LABEL.", "TEXT.LABEL_") }))
          : [failure]),
      );
    }
  }
  return { failures, promoted };
}

function finalCodes(state: MergeState): string[] {
  const after = [...state.codes];
  if (!state.formula) {
    after.push("VALIDATION.FORMULA_MISSING");
  }
  if (
    !state.otherIngredients?.items.length &&
    !state.formula?.columns.some((column) =>
      column.rows.some((row) => row.kind === "blend_component"),
    )
  ) {
    after.push("VALIDATION.INGREDIENTS_MISSING");
  }
  return after;
}

function promoteAnswer(
  source: Source,
  answer: ReplayedText | undefined,
  failure: MergeFailure,
): LabelEvidence | null {
  if (!answer?.decoded || source.kind !== "text") {
    return null;
  }
  assert.deepEqual(source.task, answer.input);
  if (answer.decoded.status === "review" || !failure.verifiedExecuted) {
    return null;
  }
  return {
    id: source.id,
    kind: "text",
    candidate: TextCandidateV3Schema.parse({
      ...answer.decoded.candidate,
      schemaVersion: 3,
    }),
  };
}

function retainReviewed(saved: SavedAssembly, failure: MergeFailure) {
  const reviewed = saved.result.provenance.find((entry) => entry.id === failure.id);
  if (reviewed?.kind === "image" && reviewed.record.codec === "vision-reviewed/1") {
    failure.reviewed = reviewed;
  }
}
