import { randomUUID } from "node:crypto";
import {
  RecoveryOutcomeSchema,
  RecoveryPreviewSchema,
  type RecoveryLedger,
  type RecoveryPreview,
  type RecoveryOutcome,
} from "@crawl-automation/app";
import type { Database, Queryable } from "@crawl-automation/platform";
import {
  LabelCollectedProductSchema,
  ReviewRecordSchema,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import {
  isRetainedVisionReview,
  isReviewedVisionRecord,
  labelCollectedHash,
  recheckDigest,
  recheckErrors,
  recordHash,
  visionRecordCodec,
} from "@crawl-automation/processing";
import { PostgresCollectedProducts } from "../postgres/postgres-collected-products.js";
import { PostgresResultRegistry } from "../postgres/postgres-result-registry.js";

interface ReceiptRow {
  fingerprint: string;
  result: unknown;
}
const previewOperation = "reviews.recover.preview";
const recoveryOperation = (reviewId: string) => `reviews.recover:${reviewId}`;
const unverified = () => recheckErrors.create("RECHECK.RECEIPT_UNVERIFIED");

/** Recovery metadata uses existing API receipts. The immutable Review row is never updated. */
export class PostgresRecoveryLedger implements RecoveryLedger {
  readonly supportsVision = true;
  constructor(private readonly database: Database) {}

  async savePreview(raw: RecoveryPreview): Promise<void> {
    const preview = RecoveryPreviewSchema.parse(raw);
    await insertReceipt(this.database, {
      id: preview.previewId,
      operation: previewOperation,
      value: preview,
    });
    const saved = await this.readPreview(preview.previewId);
    if (recheckDigest(saved) !== recheckDigest(preview)) {
      throw unverified();
    }
  }

  async readPreview(previewId: string): Promise<RecoveryPreview | null> {
    const rows = await this.database.query<ReceiptRow>(
      "SELECT fingerprint, result FROM api_request_receipt WHERE request_id = $1 AND operation = $2",
      [previewId, previewOperation],
    );
    const row = rows[0];
    return row ? RecoveryPreviewSchema.parse(checkedReceipt(row)) : null;
  }

  status(reviewId: string): Promise<RecoveryOutcome | null> {
    return recoveryStatus(this.database, reviewId);
  }

  collectionFor(observationId: string) {
    return new PostgresCollectedProducts(this.database).readObservation(observationId);
  }

  async record(input: Parameters<RecoveryLedger["record"]>[0]): Promise<RecoveryOutcome> {
    return this.database.transaction(async (tx) => {
      // One publication per Review at a time. An advisory lock, not FOR UPDATE: the API role may only read
      // review_record (Reviews are immutable), and any row lock needs UPDATE permission.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `review-recovery:${input.item.reviewId}`,
      ]);
      const review = await originalReview(tx, input.item.reviewId);
      if (recheckDigest(review) !== input.item.originalReviewHash) {
        throw recheckErrors.create("RECHECK.PREVIEW_CHANGED");
      }
      const prior = await recoveryStatus(tx, input.item.reviewId);
      if (prior?.superseded) {
        return prior;
      }
      const publishedHash = await registerRecovered(tx, review, input);
      const outcome = RecoveryOutcomeSchema.parse({
        ...input.item,
        previewId: input.previewId,
        status: publishedHash ? "recovered" : input.item.status,
        superseded: !!publishedHash,
        recordHash: publishedHash,
        recordedAt: new Date().toISOString(),
      });
      await insertReceipt(tx, {
        id: randomUUID(),
        operation: recoveryOperation(input.item.reviewId),
        value: outcome,
      });
      return outcome;
    });
  }
}

async function registerRecovered(
  tx: Queryable,
  review: ReviewRecord,
  input: Parameters<RecoveryLedger["record"]>[0],
): Promise<string | null> {
  const collection = input.collection && LabelCollectedProductSchema.parse(input.collection);
  const vision = input.vision && visionRecordCodec.parseRecord(input.vision);
  if (collection && vision) {
    throw unverified();
  }
  if (collection) {
    assertCollectionOwner(review, input);
    await new PostgresCollectedProducts(tx).append(collection);
    return labelCollectedHash(collection);
  }
  if (vision) {
    if (
      input.item.status !== "recoverable" ||
      input.item.operationId !== vision.input.operationId ||
      !isReviewedVisionRecord(review, vision)
    ) {
      throw unverified();
    }
    await new PostgresResultRegistry(tx, visionRecordCodec).register(vision);
    return recordHash(visionRecordCodec, vision);
  }
  return null;
}

function checkedReceipt(row: ReceiptRow): unknown {
  if (recheckDigest(row.result) !== row.fingerprint) {
    throw unverified();
  }
  return row.result;
}

async function recoveryStatus(db: Queryable, reviewId: string): Promise<RecoveryOutcome | null> {
  const rows = await db.query<ReceiptRow>(
    `SELECT fingerprint, result FROM api_request_receipt WHERE operation = $1
     ORDER BY created_at DESC, request_id DESC LIMIT 1`,
    [recoveryOperation(reviewId)],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  const result = RecoveryOutcomeSchema.parse(checkedReceipt(row));
  if (result.reviewId !== reviewId) {
    throw unverified();
  }
  if (result.superseded) {
    const review = await originalReview(db, reviewId);
    const hash = isRetainedVisionReview(review)
      ? await visionResultHash(db, result.operationId)
      : await collectionHash(db, result.operationId);
    if (!hash || hash !== result.recordHash) {
      throw unverified();
    }
  }
  return result;
}

async function insertReceipt(db: Queryable, at: { id: string; operation: string; value: unknown }) {
  await db.query(
    `INSERT INTO api_request_receipt (request_id, operation, fingerprint, result)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [at.id, at.operation, recheckDigest(at.value), JSON.stringify(at.value)],
  );
}

async function originalReview(db: Queryable, reviewId: string) {
  const rows = await db.query<{ record: unknown; record_hash: string }>(
    "SELECT record, record_hash FROM review_record WHERE review_id = $1",
    [reviewId],
  );
  const row = rows[0];
  if (!row || recheckDigest(row.record) !== row.record_hash) {
    throw unverified();
  }
  const review = ReviewRecordSchema.parse(row.record);
  if (review.reviewId !== reviewId) {
    throw unverified();
  }
  return review;
}

async function visionResultHash(db: Queryable, operationId: string | null) {
  const vision =
    operationId && (await new PostgresResultRegistry(db, visionRecordCodec).read(operationId));
  return vision ? recordHash(visionRecordCodec, vision) : null;
}

async function collectionHash(db: Queryable, operationId: string | null) {
  const collection = operationId && (await new PostgresCollectedProducts(db).read(operationId));
  return collection ? labelCollectedHash(collection) : null;
}

function assertCollectionOwner(
  review: ReviewRecord,
  input: Parameters<RecoveryLedger["record"]>[0],
) {
  const collection = input.collection;
  if (
    !collection ||
    input.item.status !== "recoverable" ||
    collection.operationId !== input.item.operationId ||
    recheckDigest(collection.observation) !== recheckDigest(review.observation)
  ) {
    throw unverified();
  }
}
