import { recordRecovery } from "@crawl-automation/platform";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ObjectStore } from "@crawl-automation/platform";
import { sha256 } from "@crawl-automation/platform";
import {
  ReviewRecordSchema,
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
}

/** Policies whose Reviews are immutable results: a cold worker returns the existing Review, never a second one. */
const STABLE = [
  "label-image-first/2",
  "label-image-first/3",
  "label-image-first/4",
  "label-image-first/5",
  "label-image-first/6",
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
  const { input, codes, stage, candidate, existingCollection } = review;
  const observation = input.manifest.observation;
  const admission = !!input.manifest.admission;
  const assemblySchema = admission ? "label-product-assembly/2" : "label-product-assembly/1";
  const collectedSchema = admission ? "collected-product/4" : "collected-product/3";
  const existing = existingCollection
    ? { existingCollection, versionPolicy: "retain-first/1" }
    : {};
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
    error: { name: "LabelProductReview", details: { input, codes, ...existing } },
    candidate: candidate
      ? { schema: stage === "assembly" ? assemblySchema : collectedSchema, value: candidate }
      : null,
    inspection: { kind: "none" },
  });
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
  if (!isDeepStrictEqual(saved, { ...shared.record, occurredAt: saved.occurredAt })) {
    throw unverified();
  }
  return saved;
}
