import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  LabelCollectedProductSchema,
  ReviewRecordSchema,
  VisionTaskSchema,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import {
  buildStepReview,
  decodeVisionResult,
  labelCollectedHash,
  prepareVisionRecord,
  recheckDigest,
  recordHash,
  visionRecordCodec,
} from "@crawl-automation/processing";
import type { Database, Queryable } from "@crawl-automation/platform";
import type { RecoveryItem, RecoveryPreview } from "@crawl-automation/app";
import savedProduct from "../postgres/fixtures/collected-product.json" with { type: "json" };
import { PostgresRecoveryLedger } from "./postgres-recovery-ledger.js";

function fixture() {
  const collection = LabelCollectedProductSchema.parse({
    ...savedProduct,
    operationId: "recovered-version",
  });
  const observation = collection.observation;
  const review = buildStepReview({
    reviewId: "product-review",
    task: { ...observation, operationId: "old-product", inputFingerprint: "a".repeat(64) },
    observation,
    stage: "product.label.assembly",
    category: "VALIDATION",
    code: "VALIDATION.FORMULA_MISSING",
    fact: "unknown",
    evidenceKey: "original/assembly.json",
    blockedBy: null,
    error: { name: "original", details: {} },
    candidate: null,
    inspection: { kind: "none" },
  });
  const item: RecoveryItem = {
    reviewId: review.reviewId,
    originalReviewHash: recheckDigest(review),
    status: "recoverable",
    codes: [],
    digest: "b".repeat(64),
    operationId: collection.operationId,
  };
  const preview: RecoveryPreview = {
    previewId: randomUUID(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    items: [item],
  };
  return { collection, review, item, preview };
}

const visionCorpus = new URL(
  "../../../../tools/diag-corpus/amount-state/vision-fc397c07-85ea-4d49-b110-132ccfb620bb.json",
  import.meta.url,
);

function visionFixture() {
  const entry = JSON.parse(readFileSync(visionCorpus, "utf8")) as {
    review: unknown;
    files: { key: string; content: unknown }[];
  };
  const review = ReviewRecordSchema.parse(entry.review);
  const task = VisionTaskSchema.parse((review.rawError.details as { task: unknown }).task);
  const response = entry.files.find((file) => file.key === review.failure.evidenceKey)?.content as {
    raw: string;
  };
  const decoded = decodeVisionResult(task.input, response.raw);
  if (decoded.status === "review") {
    throw new Error("fixture is no longer recoverable");
  }
  const vision = prepareVisionRecord(
    task,
    { bytes: Buffer.from(JSON.stringify(response)), status: decoded.status },
    "storage",
  ).record;
  const item: RecoveryItem = {
    reviewId: review.reviewId,
    originalReviewHash: recheckDigest(review),
    status: "recoverable",
    codes: [],
    digest: "b".repeat(64),
    operationId: task.input.operationId,
  };
  return { review, vision, item };
}

function databaseFixture(data: { review: ReviewRecord }) {
  const receipts: { requestId: string; operation: string; fingerprint: string; result: unknown }[] =
    [];
  let collected: { observation_id: string; record_hash: string; record: unknown } | null = null;
  let processing: { operation_id: string; record_hash: string; record: unknown } | null = null;
  let rejectReceipt = false;
  const receiptQuery = (sql: string, params: readonly unknown[]): object[] => {
    if (!sql.includes("INSERT INTO api_request_receipt")) {
      return sql.includes("request_id = $1")
        ? receipts.filter((row) => row.requestId === params[0] && row.operation === params[1])
        : receipts.filter((row) => row.operation === params[0]).slice(-1);
    }
    if (rejectReceipt) {
      throw new Error("receipt write failed");
    }
    receipts.push({
      requestId: String(params[0]),
      operation: String(params[1]),
      fingerprint: String(params[2]),
      result: JSON.parse(String(params[3])),
    });
    return [];
  };
  const processingQuery = (sql: string, params: readonly unknown[]): object[] => {
    if (sql.includes("INSERT INTO public.processing_result")) {
      processing ??= {
        operation_id: String(params[0]),
        record_hash: String(params[1]),
        record: JSON.parse(String(params[2])),
      };
      return [];
    }
    return processing && processing.operation_id === params[0] ? [processing] : [];
  };
  const run = async (sql: string, params: readonly unknown[] = []): Promise<object[]> => {
    if (sql.includes("api_request_receipt")) {
      return receiptQuery(sql, params);
    }
    if (sql.includes("FROM review_record")) {
      return [
        {
          review_id: data.review.reviewId,
          record: data.review,
          record_hash: recheckDigest(data.review),
        },
      ];
    }
    if (sql.includes("INSERT INTO public.collected_product")) {
      collected = {
        observation_id: String(params[1]),
        record_hash: String(params[2]),
        record: JSON.parse(String(params[3])),
      };
      return [];
    }
    if (sql.includes("FROM public.collected_product")) {
      return collected ? [collected] : [];
    }
    if (sql.includes("public.processing_result")) {
      return processingQuery(sql, params);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  // The publication's advisory lock answers nothing.
  const query = vi.fn((sql: string, params?: readonly unknown[]) =>
    sql.includes("pg_advisory_xact_lock") ? Promise.resolve([]) : run(sql, params),
  );
  const typedQuery: Queryable["query"] = async <Row extends object>(
    sql: string,
    params?: readonly unknown[],
  ) => (await query(sql, params)) as Row[];
  const transaction = vi.fn();
  const transact = async <Result>(work: (tx: Queryable) => Promise<Result>) => {
    transaction();
    const snapshot = collected;
    const processingSnapshot = processing;
    const count = receipts.length;
    try {
      return await work({ query: typedQuery });
    } catch (error) {
      collected = snapshot;
      processing = processingSnapshot;
      receipts.splice(count);
      throw error;
    }
  };
  const database: Database = {
    query: typedQuery,
    transaction: transact,
    close: async () => undefined,
  };
  return {
    database,
    query,
    transaction,
    receipts,
    collected: () => collected,
    processing: () => processing,
    rejectReceipt: () => {
      rejectReceipt = true;
    },
  };
}

describe("recovery ledger", () => {
  it("keeps dry-run reports in existing API receipts, detecting changed stored reports", async () => {
    const data = fixture();
    const db = databaseFixture(data);
    const ledger = new PostgresRecoveryLedger(db.database);
    await ledger.savePreview(data.preview);
    expect(await ledger.readPreview(data.preview.previewId)).toEqual(data.preview);
    expect(db.collected()).toBeNull();
    const receipt = db.receipts[0];
    if (!receipt) {
      throw new Error("missing receipt");
    }
    receipt.result = { ...data.preview, items: [] };
    await expect(ledger.readPreview(data.preview.previewId)).rejects.toMatchObject({
      code: "RECHECK.RECEIPT_UNVERIFIED",
    });
  });

  it("registers the collection and supersession atomically, retaining the exact original Review", async () => {
    const data = fixture();
    const before = structuredClone(data.review);
    const db = databaseFixture(data);
    const ledger = new PostgresRecoveryLedger(db.database);
    const input = {
      previewId: data.preview.previewId,
      item: data.item,
      collection: data.collection,
    };
    const outcome = await ledger.record(input);
    expect(outcome).toMatchObject({
      status: "recovered",
      superseded: true,
      recordHash: labelCollectedHash(data.collection),
    });
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(await ledger.status(data.review.reviewId)).toEqual(outcome);
    expect(data.review).toEqual(before);
    expect(db.query.mock.calls.every(([sql]) => !/UPDATE|DELETE/.test(sql))).toBe(true);
    expect(await ledger.record(input)).toEqual(outcome);
    expect(db.receipts).toHaveLength(1);
  });

  it("leaves no collection if registering its recovery receipt fails", async () => {
    const data = fixture();
    const db = databaseFixture(data);
    db.rejectReceipt();
    const ledger = new PostgresRecoveryLedger(db.database);
    await expect(
      ledger.record({
        previewId: data.preview.previewId,
        item: data.item,
        collection: data.collection,
      }),
    ).rejects.toThrow("receipt write failed");
    expect(db.collected()).toBeNull();
    expect(db.receipts).toHaveLength(0);
  });

  it("refuses a different original hash or product identity before inserting a collection", async () => {
    const data = fixture();
    const db = databaseFixture(data);
    const ledger = new PostgresRecoveryLedger(db.database);
    await expect(
      ledger.record({
        previewId: data.preview.previewId,
        item: { ...data.item, originalReviewHash: "f".repeat(64) },
        collection: data.collection,
      }),
    ).rejects.toMatchObject({ code: "RECHECK.PREVIEW_CHANGED" });
    expect(db.collected()).toBeNull();
  });

  it.skipIf(!existsSync(visionCorpus))(
    "registers a retained vision result and recovery receipt in one transaction",
    async () => {
      const data = visionFixture();
      const before = structuredClone(data.review);
      const db = databaseFixture(data);
      const ledger = new PostgresRecoveryLedger(db.database);
      const input = {
        previewId: randomUUID(),
        item: data.item,
        collection: null,
        vision: data.vision,
      };
      const outcome = await ledger.record(input);
      expect(outcome).toMatchObject({
        status: "recovered",
        superseded: true,
        recordHash: recordHash(visionRecordCodec, data.vision),
      });
      expect(db.processing()?.record).toEqual(data.vision);
      expect(await ledger.status(data.review.reviewId)).toEqual(outcome);
      expect(await ledger.record(input)).toEqual(outcome);
      expect(db.receipts).toHaveLength(1);
      expect(data.review).toEqual(before);
      expect(db.query.mock.calls.every(([sql]) => !/UPDATE|DELETE/.test(sql))).toBe(true);
    },
  );

  it.skipIf(!existsSync(visionCorpus))(
    "rolls back the vision result when its receipt fails",
    async () => {
      const data = visionFixture();
      const db = databaseFixture(data);
      db.rejectReceipt();
      const ledger = new PostgresRecoveryLedger(db.database);
      await expect(
        ledger.record({
          previewId: randomUUID(),
          item: data.item,
          collection: null,
          vision: data.vision,
        }),
      ).rejects.toThrow("receipt write failed");
      expect(db.processing()).toBeNull();
      expect(db.receipts).toHaveLength(0);
    },
  );

  it.skipIf(!existsSync(visionCorpus))(
    "refuses a vision record belonging to another task",
    async () => {
      const data = visionFixture();
      const db = databaseFixture(data);
      const ledger = new PostgresRecoveryLedger(db.database);
      await expect(
        ledger.record({
          previewId: randomUUID(),
          item: data.item,
          collection: null,
          vision: { ...data.vision, configFingerprint: "f".repeat(64) },
        }),
      ).rejects.toMatchObject({ code: "RECHECK.RECEIPT_UNVERIFIED" });
      expect(db.processing()).toBeNull();
    },
  );
});
