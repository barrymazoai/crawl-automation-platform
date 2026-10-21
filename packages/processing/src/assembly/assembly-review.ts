import { recordRecovery } from "@crawl-automation/platform";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ObjectStore } from "@crawl-automation/platform";
import { sha256 } from "@crawl-automation/platform";
import {
  ReviewRecordSchema,
  ingredientConflictDetails,
  type LabelProductJoin,
  type ProductImageOutcome,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import { decodeJson, encodeJson } from "../results/result-record.js";
import { appendConfirmed, type ReviewLedger } from "../step/kept-review.js";
import { buildStepReview } from "../step/step-review.js";
import { assemblyFailure } from "./assembly-errors.js";
import { ASSEMBLY_LIMIT, keepLocally } from "./assembly-files.js";
import { retentionSignal } from "../step/retention.js";
import type { SafeErrorSummary } from "@crawl-automation/platform/errors/summary";

export interface AssemblyStores {
  local: ObjectStore;
  remote: ObjectStore;
  reviews: ReviewLedger;
}

export interface ExistingCollection {
  operationId: string;
  observationId: string;
  recordHash: string;
}

export interface AssemblyReviewCase {
  input: LabelProductJoin;
  codes: string[];
  key: string;
  stage: "assembly" | "collect";
  candidate: unknown;
  existingCollection?: ExistingCollection | undefined;
  cause?: SafeErrorSummary | undefined;
  sourceCauses?: { sourceId: string; cause: SafeErrorSummary }[];
}

/** Policies whose Reviews are immutable results: a cold worker returns the existing Review, never a second one. */
const STABLE = [
  "label-image-first/2",
  "label-image-first/3",
  "label-image-first/4",
  "label-image-first/5",
  "label-image-first/6",
  "label-image-first/7",
];
const unverified = () => assemblyFailure("LABEL_PRODUCT.REVIEW_UNVERIFIED");

/** The Review of a product that could not be assembled or collected: kept locally, then in the ledger. */
export async function recordAssemblyReview(
  stores: AssemblyStores,
  review: AssemblyReviewCase,
): Promise<ProductImageOutcome> {
  const signal = retentionSignal();
  const stable = STABLE.includes(review.input.manifest.evidencePolicy ?? "");
  const identity = stable ? sha256(encodeJson(identityParts(review))) : randomUUID();
  let record = assemblyReviewRecord(review, identity);
  if (stable) {
    record = await sharedReview(
      stores.remote,
      { record, key: stableReviewKey(review, identity) },
      signal,
    );
  }
  const key = `label-product-reviews/${record.reviewId}.json`;
  await keepLocally(stores.local, { key, bytes: encodeJson(record) }, signal);
  await appendConfirmed(stores.reviews, record, unverified);
  return {
    status: "review",
    reviewId: record.reviewId,
    evidenceKey: review.key,
    codes: review.codes,
    automaticRetry: false,
  };
}

function identityParts(review: AssemblyReviewCase): unknown[] {
  const { stage, input, codes, key, candidate, existingCollection } = review;
  return [stage, input, codes, key, candidate, ...(existingCollection ? [existingCollection] : [])];
}

const stableReviewKey = (review: AssemblyReviewCase, identity: string) =>
  `v3/label-products/${review.input.manifest.operationId}/reviews/${identity}.json`;

function assemblyReviewRecord(review: AssemblyReviewCase, identity: string): ReviewRecord {
  const { input, codes, stage, candidate } = review;
  const observation = input.manifest.observation;
  const admission = !!input.manifest.admission;
  const assemblySchema = admission ? "label-product-assembly/2" : "label-product-assembly/1";
  const collectedSchema =
    input.manifest.evidencePolicy === "label-image-first/7"
      ? "collected-product/5"
      : admission
        ? "collected-product/4"
        : "collected-product/3";
  const code = codes[0] ?? "LABEL_PRODUCT.EVIDENCE_UNRESOLVED";
  return buildStepReview({
    reviewId: `label-${identity}`,
    task: {
      requestId: observation.requestId,
      observationId: observation.observationId,
      operationId: input.manifest.operationId,
      inputFingerprint: sha256(encodeJson(input)),
    },
    observation,
    stage: `product.label.${stage}`,
    category: stage === "assembly" ? "VALIDATION" : "INGEST",
    code,
    fact: "unknown",
    evidenceKey: review.key,
    blockedBy: null,
    error: { name: "LabelProductReview", details: reviewDetails(review) },
    candidate: candidate
      ? { schema: stage === "assembly" ? assemblySchema : collectedSchema, value: candidate }
      : null,
    inspection: { kind: "none" },
  });
}

function reviewDetails(review: AssemblyReviewCase) {
  const { input, codes, existingCollection, cause, sourceCauses } = review;
  const sources = ingredientSources(review.candidate);
  return {
    input,
    codes,
    ...(codes.includes("LABEL_PRODUCT.INGREDIENTS_CONFLICT") && sources.length
      ? { conflicts: ingredientConflictDetails(sources) }
      : {}),
    ...(existingCollection ? { existingCollection, versionPolicy: "retain-first/1" } : {}),
    ...(cause ? { cause } : {}),
    ...(sourceCauses?.length ? { sourceCauses } : {}),
  };
}

function ingredientSources(candidate: unknown) {
  if (!candidate || typeof candidate !== "object" || !("result" in candidate)) {
    return [];
  }
  const result = candidate.result;
  if (
    !result ||
    typeof result !== "object" ||
    !("provenance" in result) ||
    !Array.isArray(result.provenance)
  ) {
    return [];
  }
  return result.provenance.filter(
    (
      source,
    ): source is { id: string; candidate: { otherIngredients: { items: { text: string }[] } } } =>
      !!source &&
      typeof source.id === "string" &&
      Array.isArray(source.candidate?.otherIngredients?.items),
  );
}

/** The one shared copy of a stable Review in R2: written once, and the copy that exists is the one used. */
async function sharedReview(
  remote: ObjectStore,
  shared: { record: ReviewRecord; key: string },
  signal: AbortSignal,
): Promise<ReviewRecord> {
  let bytes = await remote.read(shared.key, ASSEMBLY_LIMIT, signal);
  if (!bytes) {
    try {
      await remote.create(shared.key, encodeJson(shared.record), "application/json", signal);
    } catch (error) {
      recordRecovery(error, { operation: "assembly/assembly-review" });
      // The read-back below decides.
    }
    bytes = await remote.read(shared.key, ASSEMBLY_LIMIT, signal);
  }
  if (!bytes) {
    throw unverified();
  }
  const saved = ReviewRecordSchema.parse(decodeJson(bytes));
  if (
    !isDeepStrictEqual(
      withoutCauses(saved),
      withoutCauses({ ...shared.record, occurredAt: saved.occurredAt }),
    )
  ) {
    throw unverified();
  }
  return saved;
}

/** Diagnostics never change stable identity; an existing immutable Review keeps its first cause. */
function withoutCauses(record: ReviewRecord): ReviewRecord {
  const details = record.rawError.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return record;
  }
  const { cause: _cause, sourceCauses: _sources, ...rest } = details;
  return { ...record, rawError: { ...record.rawError, details: rest } };
}
