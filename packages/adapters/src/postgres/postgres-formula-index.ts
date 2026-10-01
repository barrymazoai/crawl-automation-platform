import type {
  FamilyCoverage,
  FormulaIndex,
  FormulaQuery,
  MemberFormula,
} from "@crawl-automation/app";
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

/** The saved capture and collected observation belong to the same verified page and run. */
const CAPTURE_IDENTITY = `h.record->>'codec' = 'v3-capture-history/1'
  AND h.record->'listing'->>'channel' = ANY($1::text[])
  AND split_part(h.record->'listing'->>'url', '?', 1) = split_part($4::text, '?', 1)`;

const CAPTURE_OWNER = `h.record->'owner'->>'runId' = p.record->'observation'->>'requestId'
  AND h.record->'owner'->>'sourceId' = p.record->'observation'->>'sourceId'`;

/** URL handles resolve only through saved page provenance, never a variant-only or fuzzy match. */
const FIND_MEMBER = `SELECT p.operation_id,
    p.record->'observation'->>'listingId' AS listing_id,
    p.record->'observation'->>'variantId' AS variant_id
  FROM collected_product p
  WHERE p.record->>'codec' IN ('collected-product/3', 'collected-product/4')
    AND p.record->'observation'->>'sourceId' IN
      (SELECT id::text FROM brand_source WHERE channel = ANY($1::text[]))
    AND p.record->'observation'->>'variantId' IS NOT DISTINCT FROM $3::text
    AND (p.record->'observation'->>'listingId' = $2 OR ($4::text IS NOT NULL AND EXISTS (
      SELECT 1 FROM product_history_source h WHERE ${CAPTURE_IDENTITY}
        AND ${CAPTURE_OWNER}
        AND (h.record->'capture'->>'variantId' IS NULL OR
          h.record->'capture'->>'variantId' = p.record->'observation'->>'variantId')
    )))
   ORDER BY p.collected_at DESC
   LIMIT 1`;

const COVERAGE = `SELECT
  EXISTS (SELECT 1 FROM product_history_source h WHERE ${CAPTURE_IDENTITY}
    AND (h.record->'capture'->>'variantId' IS NOT DISTINCT FROM $3::text OR EXISTS (
      SELECT 1 FROM collected_product p WHERE ${CAPTURE_OWNER}
        AND p.record->'observation'->>'variantId' IS NOT DISTINCT FROM $3::text
        AND p.record->>'codec' IN ('collected-product/3', 'collected-product/4')
    ))) AS seen,
  EXISTS (SELECT 1 FROM queue_item q WHERE q.channel = ANY($1::text[])
    AND q.listing_id = $2 AND q.variant_id IS NOT DISTINCT FROM $3::text
    AND q.state IN ('queued', 'ready', 'running', 'following')) AS queued`;

const READ_SAVED = "SELECT record FROM collected_product WHERE operation_id = $1";

/** Formulas collected for products, across the channels that share them. */
export class PostgresFormulaIndex implements FormulaIndex {
  constructor(private readonly database: Queryable) {}

  findKnown(query: FormulaQuery): Promise<{ operationId: string } | null> {
    return this.first(FIND_KNOWN, query);
  }

  async findForMember(query: FormulaQuery): Promise<MemberFormula | null> {
    const rows = await this.database.query<{
      operation_id: string;
      listing_id: string;
      variant_id: string | null;
    }>(FIND_MEMBER, [
      [...query.channels],
      query.listingId,
      query.variantId,
      query.memberUrl ?? null,
    ]);
    const row = rows[0];
    return row
      ? { operationId: row.operation_id, listingId: row.listing_id, variantId: row.variant_id }
      : null;
  }

  async familyCoverage(queries: FormulaQuery[]): Promise<FamilyCoverage> {
    const members = await Promise.all(
      queries.map(async (query) => {
        const rows = await this.database.query<{ seen: boolean; queued: boolean }>(COVERAGE, [
          [...query.channels],
          query.listingId,
          query.variantId,
          query.memberUrl ?? null,
        ]);
        return {
          listingId: query.listingId,
          variantId: query.variantId,
          url: query.memberUrl ?? "",
          seen: rows[0]?.seen ?? false,
          queued: rows[0]?.queued ?? false,
        };
      }),
    );
    return { scope: "enumerated-family", members };
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
