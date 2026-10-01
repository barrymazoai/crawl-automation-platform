import { isDeepStrictEqual } from "node:util";
import {
  ReviewRecordSchema,
  type SavedEvidenceSource,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import { sourceReviewFailure } from "../assembly/source-review.js";
import { labelFailure } from "./label-errors.js";
import type { LabelPlans } from "./label-plans.js";
import type { LabelInspection } from "./selection-model.js";
import type {
  OrderedEvidence,
  OrderedProgress,
  OrderedSource,
  OrderedState,
} from "./ordered-model.js";

export interface OrderedDeps {
  inspection: LabelInspection;
  visionFingerprint: (task: VisionTask) => string;
}

/** Read only the sources actually attempted, re-verifying originals and exact task receipts. */
export async function orderedEvidence(
  plans: LabelPlans,
  deps: OrderedDeps,
  at: { request: OrderedProgress; signal: AbortSignal },
): Promise<OrderedEvidence> {
  const loaded = await plans.load(at.request.input, at.signal);
  const evidence: OrderedEvidence = {
    sources: [],
    entries: [],
    failures: [],
    reasons: [],
    terminal: false,
  };
  for (const state of at.request.states) {
    const source = loaded.manifest.sources.find((entry) => entry.id === state.id);
    if (!source) {
      throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
    }
    await readState({ plans, deps, evidence, ...at }, { source, state });
  }
  return evidence;
}

interface Reading {
  plans: LabelPlans;
  deps: OrderedDeps;
  evidence: OrderedEvidence;
  request: OrderedProgress;
  signal: AbortSignal;
}

async function readState(
  reading: Reading,
  at: { source: SavedEvidenceSource; state: OrderedState },
) {
  const { source, state } = at;
  const { plans, deps, evidence, request, signal } = reading;
  if (["unresolved", "rejected"].includes(state.status)) {
    evidence.terminal = true;
    evidence.reasons.push({
      progress: 0,
      failure: {
        sourceId: source.id,
        code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
        executionFact: "unknown",
      },
    });
    return;
  }
  if (state.status === "review" && (await preparationReview(reading, { source, state }))) {
    return;
  }
  await retainedFile(deps.inspection, source, signal);
  const result = await plans.source({ input: request.input, sourceId: source.id }, signal);
  if (result.status === "not_matched") {
    if (state.status !== "not_matched") {
      throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
    }
    return;
  }
  evidence.sources.push(result.source);
  if (state.status === "not_matched") {
    throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
  }
  if (state.status === "review") {
    return modelReview(reading, { source: result.source, state });
  }
  evidence.entries.push(await registeredSource(deps.inspection, result.source, signal));
}

function registeredSource(inspection: LabelInspection, source: OrderedSource, signal: AbortSignal) {
  if (!inspection.readSource) {
    throw labelFailure("CHANNEL.LABEL_SELECTION_UNAVAILABLE");
  }
  return inspection.readSource(source, signal);
}

async function retainedFile(
  inspection: LabelInspection,
  source: SavedEvidenceSource,
  signal: AbortSignal,
) {
  if (source.kind === "file-image" && !(await inspection.file(source, signal))) {
    throw labelFailure("CHANNEL.LABEL_FILE_UNVERIFIED");
  }
}

/** Preparation failures are allowed to fall back only with a verified, ended execution. */
async function preparationReview(
  reading: Reading,
  at: { source: SavedEvidenceSource; state: Extract<OrderedState, { status: "review" }> },
): Promise<boolean> {
  const { deps, request, signal, evidence } = reading;
  const raw = await deps.inspection.review(at.state.reviewId);
  if (!raw) {
    throw labelFailure("SAVED.REVIEW_UNVERIFIED");
  }
  const review = ReviewRecordSchema.parse(raw);
  if (
    review.reviewId !== at.state.reviewId ||
    !isDeepStrictEqual(review.observation, request.input.owner)
  ) {
    throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
  }
  if (["codex.vision", "codex.text", "text.receipt"].includes(review.failure.stage)) {
    return false;
  }
  const resolved = await deps.inspection.reviewSource?.(at.source, at.state, signal);
  if (resolved?.status !== "review" || resolved.code !== review.failure.code) {
    throw labelFailure("SAVED.REVIEW_UNVERIFIED");
  }
  const { code, executionFact } = review.failure;
  evidence.terminal ||= blocksFallback(code, executionFact);
  evidence.reasons.push({ progress: 1, failure: { sourceId: at.source.id, code, executionFact } });
  return true;
}

/** A missing or conflicting evidence identity is never a content-based reason to skip a source. */
function blocksFallback(code: string, executionFact: string) {
  return (
    executionFact === "unknown" ||
    /(?:IDENTITY|CONFLICT|MISMATCH|UNVERIFIED|UNKNOWN|PENDING|NOT_DURABLE|UNCONFIRMED)/.test(code)
  );
}

async function modelReview(
  reading: Reading,
  at: {
    source: OrderedEvidence["sources"][number];
    state: Extract<OrderedState, { status: "review" }>;
  },
) {
  const { deps, evidence, request } = reading;
  const reviews = {
    read: async (id: string) => {
      const raw = await deps.inspection.review(id);
      return raw ? ReviewRecordSchema.parse(raw) : null;
    },
  };
  const manifest = {
    operationId: request.input.operationId,
    observation: request.input.owner,
    sources: [at.source],
  };
  const failure = await sourceReviewFailure(
    { reviews, visionFingerprint: deps.visionFingerprint },
    at.source,
    {
      input: { manifest, states: [at.state] },
      reviewId: at.state.reviewId,
    },
  );
  evidence.failures.push(failure);
  evidence.terminal ||= !failure.verifiedExecuted;
  evidence.reasons.push({
    progress: failure.candidate?.formula || failure.hasFormula ? 4 : 3,
    failure: {
      sourceId: at.source.id,
      code: failure.code,
      executionFact: failure.verifiedExecuted ? "executed" : "unknown",
    },
  });
}
