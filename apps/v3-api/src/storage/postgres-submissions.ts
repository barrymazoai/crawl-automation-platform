import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CollectionSnapshot, CollectionSubmission, SubmitCollection, Id, ScheduleTick, ScheduleTickResult } from "@crawl-automation/v3-contracts";
import { tickRequestId } from "../schedules/tick.js";
import type { SubmissionRepository } from "../submissions/port.js";
import { ApiError } from "../errors.js";
import { withRequestReceipt } from "./request-receipts.js";

const columns = 'r.request_id AS "requestId", r.workflow_id AS "workflowId", r.snapshot, r.created_at AS "createdAt"';
const Row = z.object({ requestId: Id, workflowId: z.string(), snapshot: CollectionSnapshot, createdAt: z.date() });
function fromRow(row: unknown): CollectionSubmission {
  const value = Row.parse(row);
  return CollectionSubmission.parse({ ...value, state: "PENDING_DELIVERY", createdAt: value.createdAt.toISOString() });
}

export class PostgresSubmissions implements SubmissionRepository {
  constructor(private readonly pool: Pool) {}

  accept(brandId: string, sourceId: string, input: SubmitCollection, requestId: string) {
    // Validate/canonicalize at the application boundary too, not just HTTP.
    brandId = Id.parse(brandId);
    sourceId = Id.parse(sourceId);
    requestId = Id.parse(requestId);
    input = SubmitCollection.parse(input);
    return withRequestReceipt(this.pool, requestId, `collection.submit:${brandId}:${sourceId}`, input, CollectionSubmission,
      client => this.acceptSource(client, brandId, sourceId, input, requestId));
  }

  acceptScheduled(raw: ScheduleTick) {
    const tick = ScheduleTick.parse(raw), requestId = tickRequestId(tick), d = tick.definition;
    return withRequestReceipt(this.pool, requestId, `collection.schedule:${d.brandId}:${d.sourceId}`, tick, ScheduleTickResult, async client => {
      try {
        await this.acceptSource(client, d.brandId, d.sourceId, { sourceRevision: d.sourceRevision }, requestId);
        return ScheduleTickResult.parse({ requestId, state: "ACCEPTED", reason: null });
      } catch (error) {
        if (error instanceof ApiError && ["SOURCE_BUSY", "SOURCE_DISABLED", "REVISION_CONFLICT", "SOURCE_NOT_FOUND"].includes(error.code))
          return ScheduleTickResult.parse({ requestId, state: error.code === "SOURCE_BUSY" ? "SKIPPED" : "REVIEW", reason: error.code });
        throw error;
      }
    });
  }

  private async acceptSource(client: PoolClient, brandId: string, sourceId: string, input: SubmitCollection, requestId: string) {
      // Freeze the source and brand name in the same transaction as acceptance.
      // Source edits and enable/disable updates must serialize with this lock.
      const selected = await client.query(
        `SELECT s.enabled, s.revision, b.id AS "brandId", b.name AS "brandName", s.id AS "sourceId",
          s.revision AS "sourceRevision", s.channel, s.region, s.url
         FROM brand_source s JOIN brand b ON b.id=s.brand_id
         WHERE s.id=$1 AND s.brand_id=$2 FOR UPDATE OF s FOR SHARE OF b`, [sourceId, brandId],
      );
      const row = selected.rows[0];
      if (!row) throw new ApiError(404, "SOURCE_NOT_FOUND", "Source not found for this Brand.");
      if (!row.enabled) throw new ApiError(409, "SOURCE_DISABLED", "Enable the source before submitting a new collection.");
      if (row.revision !== input.sourceRevision)
        throw new ApiError(409, "REVISION_CONFLICT", "Source changed; reload before submitting.");
      const { enabled: _enabled, revision: _revision, ...fields } = row;
      const snapshot = CollectionSnapshot.parse(fields);
      // All intake paths already hold the source lock. Check BEFORE inserting:
      // a skipped tick must commit its receipt without a collection row.
      // Browser channels own one page session per source; request-based channels (amazon) admit concurrent requests.
      if (snapshot.channel !== "amazon") {
        const active = await client.query("SELECT 1 FROM source_submission_guard WHERE source_id=$1", [sourceId]);
        if (active.rowCount) throw new ApiError(409, "SOURCE_BUSY", "This source already has an accepted request.");
      }
      const result = await client.query(
        `INSERT INTO collection_submission(request_id,source_id,workflow_id,snapshot) VALUES($1,$2,$3,$4::jsonb)
         RETURNING request_id AS "requestId", workflow_id AS "workflowId", snapshot, created_at AS "createdAt"`,
        [requestId, sourceId, `v3-collection-${requestId}`, JSON.stringify(snapshot)],
      );
      const guard = await client.query(
        "INSERT INTO source_submission_guard(source_id,request_id) VALUES($1,$2) ON CONFLICT(request_id) DO NOTHING RETURNING source_id", [sourceId, requestId],
      );
      if (!guard.rowCount) throw new Error("Source guard changed despite source lock; roll back transaction");
      return fromRow(result.rows[0]);
  }

  async get(requestId: string) {
    const result = await this.pool.query(`SELECT ${columns} FROM collection_submission r WHERE r.request_id=$1`, [Id.parse(requestId)]);
    if (!result.rows[0]) throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission not found.");
    return fromRow(result.rows[0]);
  }

  async active(brandId: string, sourceId: string) {
    // A single query distinguishes absent source vs. an existing source without intake.
    const result = await this.pool.query(
      `SELECT ${columns} FROM brand_source s
       LEFT JOIN source_submission_guard g ON g.source_id=s.id
       LEFT JOIN collection_submission r ON r.request_id=g.request_id
       WHERE s.id=$1 AND s.brand_id=$2`, [Id.parse(sourceId), Id.parse(brandId)],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, "SOURCE_NOT_FOUND", "Source not found for this Brand.");
    return row.requestId === null ? null : fromRow(row);
  }
}
