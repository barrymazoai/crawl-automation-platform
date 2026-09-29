import type { FormulaIndex } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import type { FormulaKey } from "@crawl-automation/workflows";

/**
 * The newest formula collected for one product of one channel: same listing and same variant (size), from any
 * source of that channel. Only the current collected-product structures count.
 */
const FIND_KNOWN = `
  SELECT p.operation_id
    FROM collected_product p
   WHERE p.record->'observation'->>'listingId' = $2
     AND p.record->'observation'->>'variantId' IS NOT DISTINCT FROM $3
     AND p.record->>'codec' IN ('collected-product/3', 'collected-product/4')
     AND p.record->'observation'->>'sourceId' IN (SELECT id::text FROM brand_source WHERE channel = $1)
   ORDER BY p.collected_at DESC
   LIMIT 1`;

export class PostgresFormulaIndex implements FormulaIndex {
  constructor(private readonly database: Queryable) {}

  async findKnown(key: FormulaKey): Promise<{ operationId: string } | null> {
    const rows = await this.database.query<{ operation_id: string }>(FIND_KNOWN, [
      key.channel,
      key.listingId,
      key.variantId,
    ]);
    const row = rows[0];
    return row ? { operationId: row.operation_id } : null;
  }
}
