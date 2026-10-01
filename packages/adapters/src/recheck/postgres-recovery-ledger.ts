import { randomUUID } from "node:crypto";
import {
  RecoveryOutcomeSchema,
  RecoveryPreviewSchema,
  type RecoveryLedger,
  type RecoveryPreview,
  type RecoveryOutcome,
} from "@crawl-automation/app";
import type { Database, Queryable } from "@crawl-automation/platform";
import { LabelCollectedProductSchema, ReviewRecordSchema } from "@crawl-automation/v3-contracts";
import { labelCollectedHash, recheckDigest, recheckErrors } from "@crawl-automation/processing";
import { PostgresCollectedProducts } from "../postgres/postgres-collected-products.js";

interface ReceiptRow {
  fingerprint: string;
  result: unknown;
}
const previewOperation = "reviews.recover.preview";
const recoveryOperation = (reviewId: string) => `reviews.recover:${reviewId}`;
const unverified = () => recheckErrors.create("RECHECK.RECEIPT_UNVERIFIED");

/** Recovery metadata uses existing API receipts. The immutable Review row is never updated. */
export class PostgresRecoveryLedger implements RecoveryLedger {
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
      await tx.query("SELECT review_id FROM review_record WHERE review_id = $1 FOR UPDATE", [
        input.item.reviewId,
      ]);
      await assertOriginal(tx, input.item);
      const prior = await recoveryStatus(tx, input.item.reviewId);
      if (prior?.superseded) {
        return prior;
      }
      const collection = input.collection && LabelCollectedProductSchema.parse(input.collection);
      if (collection) {
        await assertCollectionOwner(tx, input);
        await new PostgresCollectedProducts(tx).append(collection);
      }
      const outcome = RecoveryOutcomeSchema.parse({
        ...input.item,
        previewId: input.previewId,
        status: collection ? "recovered" : input.item.status,
        superseded: !!collection,
        recordHash: collection ? labelCollectedHash(collection) : null,
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
    const collection =
      result.operationId && (await new PostgresCollectedProducts(db).read(result.operationId));
    if (!collection || labelCollectedHash(collection) !== result.recordHash) {
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

async function assertOriginal(
  db: Queryable,
  item: Parameters<RecoveryLedger["record"]>[0]["item"],
) {
  if (recheckDigest(await originalReview(db, item.reviewId)) !== item.originalReviewHash) {
    throw recheckErrors.create("RECHECK.PREVIEW_CHANGED");
  }
}

async function assertCollectionOwner(
  db: Queryable,
  input: Parameters<RecoveryLedger["record"]>[0],
) {
  const review = await originalReview(db, input.item.reviewId);
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
