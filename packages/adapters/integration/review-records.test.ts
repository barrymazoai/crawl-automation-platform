import { execFileSync } from "node:child_process";
import type { Database } from "@crawl-automation/platform";
import { reviewDigest } from "@crawl-automation/processing";
import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresReviewRecords } from "../src/postgres/postgres-review-records.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";

const hasPostgres = (() => {
  try {
    execFileSync("initdb", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

function review(
  reviewId: string,
  category: "PROCESSING" | "ARTIFACT" = "PROCESSING",
): ReviewRecord {
  const ids = { requestId: `req-${reviewId}`, observationId: `obs-${reviewId}` };
  return {
    schemaVersion: 1,
    reviewId,
    occurredAt: "2026-09-30T10:00:00.000Z",
    failure: {
      ...{
        schemaVersion: 1,
        ...ids,
        operationId: `op-${reviewId}`,
        inputFingerprint: "f".repeat(64),
      },
      ...{ stage: "ocr.file/register", category, code: "OCR.EMPTY", executionFact: "executed" },
      ...{ evidenceKey: `evidence/${reviewId}.json`, blockedBy: null, automaticRetry: false },
    },
    observation: null,
    rawError: { name: "OcrError", message: "private", stack: null, details: {} },
    candidate: null,
    inspection: { kind: "none" },
  } as ReviewRecord;
}

describe.skipIf(!hasPostgres)("the Review ledger against a real PostgreSQL", () => {
  let postgres: TemporaryPostgres;
  let database: Database;
  let reviews: PostgresReviewRecords;

  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    database = postgres.database;
    reviews = new PostgresReviewRecords(database);
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  it("stores once, reads the exact record back, and answers the same receipt again", async () => {
    const record = review("review-int-1");
    const receipt = await reviews.append(record);
    expect(receipt).toEqual({
      reviewId: "review-int-1",
      recordHash: reviewDigest(record),
      registered: true,
    });
    expect(await reviews.read("review-int-1")).toEqual(record);
    expect(await reviews.append(record)).toEqual(receipt);
  });

  it("refuses a different record under the same ID and never changes the stored one", async () => {
    const record = review("review-int-2");
    await reviews.append(record);
    const changed = { ...record, occurredAt: "2026-09-30T11:00:00.000Z" };
    await expect(reviews.append(changed)).rejects.toMatchObject({ code: "REVIEW.CONFLICT" });
    await expect(database.query("DELETE FROM review_record")).rejects.toThrow();
    expect(await reviews.read("review-int-2")).toEqual(record);
  });

  it("lists newest ID first with a cursor, filters by category, and counts by category", async () => {
    await reviews.append(review("review-int-3", "ARTIFACT"));
    const page = await reviews.list({ limit: 2 });
    expect(page.items.map((item) => item.reviewId)).toEqual(["review-int-3", "review-int-2"]);
    expect(page.nextCursor).toBe("review-int-2");
    const artifacts = await reviews.list({ limit: 10, category: "ARTIFACT" });
    expect(artifacts.items.map((item) => item.reviewId)).toEqual(["review-int-3"]);
    expect(JSON.stringify(page)).not.toContain("private");
    expect(await reviews.summary()).toEqual({
      total: 3,
      categories: [
        { category: "ARTIFACT", count: 1 },
        { category: "PROCESSING", count: 2 },
      ],
    });
  });

  it("reports a row whose hash does not match as an integrity failure", async () => {
    const record = review("review-int-4");
    await database.query(
      "INSERT INTO review_record(review_id, record_hash, record) VALUES ($1, $2, $3::jsonb)",
      ["review-int-4", "0".repeat(64), JSON.stringify(record)],
    );
    await expect(reviews.read("review-int-4")).rejects.toMatchObject({ code: "REVIEW.INTEGRITY" });
  });
});
