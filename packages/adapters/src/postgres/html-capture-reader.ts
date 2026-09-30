import {
  SavedHtmlOriginalSchema,
  type EvidenceOriginalInput,
  type OriginalCaptureReader,
  type OriginalCaptureRecord,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

/** SELECT only; historical originals remain available after their 24-hour reuse window. */
export class PostgresHtmlCaptureReader implements OriginalCaptureReader {
  constructor(private readonly database: Queryable) {}

  async find(input: EvidenceOriginalInput): Promise<OriginalCaptureRecord | null> {
    const byOperation = "operationId" in input;
    const predicate = byOperation
      ? "operation_id=$1"
      : "channel=$1 AND listing_id=$2 AND variant_id IS NOT DISTINCT FROM $3";
    const values = byOperation
      ? [input.operationId]
      : [input.channel, input.listingId, input.variantId ?? null];
    const rows = await this.database.query<{ operation_id: string; original: unknown }>(
      `SELECT operation_id,original FROM html_capture WHERE state='done' AND ${predicate}
       ORDER BY captured_at DESC,requested_at DESC,operation_id DESC LIMIT 1`,
      values,
    );
    const row = rows[0];
    return row
      ? { operationId: row.operation_id, original: SavedHtmlOriginalSchema.parse(row.original) }
      : null;
  }
}
