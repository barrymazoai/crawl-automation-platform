import type { DeliveryScan, ScanCursor } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { Id } from "@crawl-automation/v3-contracts";
import { z } from "zod";

const Cursor = z.strictObject({ createdAt: z.iso.datetime(), requestId: Id });

/** Microsecond timestamps keep keyset paging exact. */
const fields = `to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
  r.request_id AS "requestId"`;

/** Amazon queue attempts are started by the queue runner, not here. */
const from = `FROM collection_submission r
  JOIN source_submission_guard g ON g.request_id = r.request_id
  LEFT JOIN workflow_delivery d ON d.request_id = r.request_id
  LEFT JOIN amazon_queue_attempt q ON q.request_id = r.request_id`;

/** A request with an unresolved issue is checked hourly, not in a hot loop. */
const due = `d.closed_at IS NULL AND q.request_id IS NULL AND (d.checked_at IS NULL
  OR d.checked_at <= clock_timestamp() - CASE WHEN d.last_issue IS NOT NULL
    THEN interval '1 hour' ELSE interval '15 seconds' END)`;

export class PostgresDeliveryScan implements DeliveryScan {
  constructor(private readonly database: Database) {}

  async upperBound(): Promise<ScanCursor | null> {
    const rows = await this.database.query(
      `SELECT ${fields} ${from} WHERE ${due} ORDER BY r.created_at DESC, r.request_id DESC LIMIT 1`,
    );
    return rows[0] ? Cursor.parse(rows[0]) : null;
  }

  async page(after: ScanCursor | null, through: ScanCursor, limit: number): Promise<ScanCursor[]> {
    const rows = await this.database.query(
      `SELECT ${fields} ${from}
       WHERE ${due} AND (r.created_at, r.request_id) <= ($1::timestamptz, $2::uuid)
         AND ($3::timestamptz IS NULL OR (r.created_at, r.request_id) > ($3::timestamptz, $4::uuid))
       ORDER BY r.created_at, r.request_id LIMIT $5`,
      [
        through.createdAt,
        through.requestId,
        after?.createdAt ?? null,
        after?.requestId ?? null,
        limit,
      ],
    );
    return rows.map((row) => Cursor.parse(row));
  }
}
