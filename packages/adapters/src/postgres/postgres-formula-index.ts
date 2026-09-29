import type { FormulaIndex, FormulaQuery } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import type { SavedFormula } from "@crawl-automation/processing";
import { LabelProductFormulaSchema, LabelProductOtherSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";

/** The part of a collected record the label check reads; the whole record was checked when it was collected. */
const SavedFormulaSchema = z.object({
  codec: z.enum(["collected-product/3", "collected-product/4"]),
  formula: LabelProductFormulaSchema,
  otherIngredients: LabelProductOtherSchema,
});

/** Collected products of these channels (the channel comes from the owning brand source). */
const COLLECTED = `
  SELECT p.operation_id, p.collected_at
    FROM collected_product p
   WHERE p.record->'observation'->>'listingId' = $2
     AND %VARIANT%
     AND p.record->>'codec' IN ('collected-product/3', 'collected-product/4')
     AND p.record->'observation'->>'sourceId' IN
         (SELECT id::text FROM brand_source WHERE channel = ANY($1::text[]))`;

/** This product's own formula (same listing and variant), or a formula linked to it, newest first. */
const FIND_KNOWN = `
  SELECT operation_id FROM (
    ${COLLECTED.replace("%VARIANT%", "p.record->'observation'->>'variantId' IS NOT DISTINCT FROM $3")}
    UNION ALL
    SELECT l.formula_operation_id, l.created_at
      FROM formula_link l
     WHERE l.channel = ANY($1::text[]) AND l.listing_id = $2 AND l.variant_id IS NOT DISTINCT FROM $3
  ) known
   ORDER BY collected_at DESC
   LIMIT 1`;

/**
 * A family member's own formula. A member is its own listing; its variant must match only when both sides name one,
 * because a page may link a member with its variant while the member was collected from its plain URL.
 */
const FIND_MEMBER = `${COLLECTED.replace(
  "%VARIANT%",
  "($3::text IS NULL OR p.record->'observation'->>'variantId' IS NULL OR p.record->'observation'->>'variantId' = $3)",
)}
   ORDER BY p.collected_at DESC
   LIMIT 1`;

const READ_SAVED = "SELECT record FROM collected_product WHERE operation_id = $1";

/** Formulas collected for products, across the channels that share them. */
export class PostgresFormulaIndex implements FormulaIndex {
  constructor(private readonly database: Queryable) {}

  findKnown(query: FormulaQuery): Promise<{ operationId: string } | null> {
    return this.first(FIND_KNOWN, query);
  }

  findForMember(query: FormulaQuery): Promise<{ operationId: string } | null> {
    return this.first(FIND_MEMBER, query);
  }

  async readSaved(operationId: string): Promise<SavedFormula | null> {
    const rows = await this.database.query<{ record: unknown }>(READ_SAVED, [operationId]);
    const parsed = SavedFormulaSchema.safeParse(rows[0]?.record);
    if (!parsed.success) {
      return null;
    }
    return { formula: parsed.data.formula, otherIngredients: parsed.data.otherIngredients };
  }

  private async first(sql: string, query: FormulaQuery): Promise<{ operationId: string } | null> {
    const rows = await this.database.query<{ operation_id: string }>(sql, [
      [...query.channels],
      query.listingId,
      query.variantId,
    ]);
    const row = rows[0];
    return row ? { operationId: row.operation_id } : null;
  }
}
