import type { Pool } from "pg";
import { Id } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { DeliveryScan, ScanCursor } from "../delivery/runner.js";

const Cursor = z.strictObject({ createdAt: z.iso.datetime(), requestId: Id });
const fields = `to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt", r.request_id AS "requestId"`;
const from = `FROM collection_submission r JOIN source_submission_guard g ON g.request_id=r.request_id
  LEFT JOIN workflow_delivery d ON d.request_id=r.request_id
  LEFT JOIN amazon_queue_attempt q ON q.request_id=r.request_id`;

// Unconfirmed terminal executions need operator review, not a hot loop. The durable
// timestamp makes the delay survive brand-web restarts and applies to existing rows.
const due = `q.request_id IS NULL AND (d.checked_at IS NULL OR d.checked_at <= clock_timestamp() -
  CASE WHEN d.last_issue IS NOT NULL THEN interval '1 hour' ELSE interval '15 seconds' END)`;

export class PostgresDeliveryScan implements DeliveryScan {
  constructor(private readonly pool: Pool) {}
  async upperBound(): Promise<ScanCursor | null> {
    const result = await this.pool.query(`SELECT ${fields} ${from}
      WHERE d.closed_at IS NULL AND ${due} ORDER BY r.created_at DESC,r.request_id DESC LIMIT 1`);
    return result.rows[0] ? Cursor.parse(result.rows[0]) : null;
  }
  async page(after: ScanCursor | null, through: ScanCursor, limit: number): Promise<ScanCursor[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid delivery scan limit");
    through = Cursor.parse(through);
    if (after) after = Cursor.parse(after);
    const result = await this.pool.query(`SELECT ${fields} ${from}
      WHERE d.closed_at IS NULL AND ${due} AND (r.created_at,r.request_id) <= ($1::timestamptz,$2::uuid)
      AND ($3::timestamptz IS NULL OR (r.created_at,r.request_id) > ($3::timestamptz,$4::uuid))
      ORDER BY r.created_at,r.request_id LIMIT $5`,
      [through.createdAt, through.requestId, after?.createdAt ?? null, after?.requestId ?? null, limit]);
    return result.rows.map((row) => Cursor.parse(row));
  }
}
