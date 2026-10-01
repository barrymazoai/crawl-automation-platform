import {
  appErrors,
  type FamilyFormulaOutcome,
  type FamilyFormulaQuery,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

/** A metrics capture has one immutable owner and archive. Updates only advance its dependency status. */
export async function recordFamilyOutcome(db: Queryable, outcome: FamilyFormulaOutcome) {
  const rows = await db.query(
    `INSERT INTO family_formula_outcome
       (operation_id, run_id, brand_id, channel, listing_id, variant_id, archive_key, status, formula_operation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (operation_id) DO UPDATE SET
       status = CASE WHEN excluded.status = 'metrics-complete' OR family_formula_outcome.status = 'formula-linked'
         THEN family_formula_outcome.status ELSE excluded.status END,
       formula_operation_id = coalesce(family_formula_outcome.formula_operation_id, excluded.formula_operation_id),
       updated_at = clock_timestamp()
     WHERE ROW(family_formula_outcome.run_id, family_formula_outcome.brand_id, family_formula_outcome.channel,
       family_formula_outcome.listing_id, family_formula_outcome.variant_id, family_formula_outcome.archive_key)
       IS NOT DISTINCT FROM ROW(excluded.run_id, excluded.brand_id, excluded.channel, excluded.listing_id,
       excluded.variant_id, excluded.archive_key)
     RETURNING operation_id`,
    [
      outcome.operationId,
      outcome.runId,
      outcome.brandId,
      outcome.channel,
      outcome.listingId,
      outcome.variantId,
      outcome.archiveKey,
      outcome.status,
      outcome.formulaOperationId,
    ],
  );
  if (rows.length !== 1) {
    throw appErrors.create("QUEUE.IMPORT_CONFLICT", {
      details: { operationId: outcome.operationId },
    });
  }
}

export function familyOutcomes(db: Queryable, query: FamilyFormulaQuery) {
  return db.query<FamilyFormulaOutcome>(
    `SELECT operation_id AS "operationId", run_id::text AS "runId", brand_id::text AS "brandId",
       channel, listing_id AS "listingId", variant_id AS "variantId", archive_key AS "archiveKey",
       status, formula_operation_id AS "formulaOperationId"
     FROM family_formula_outcome WHERE operation_id = ANY($1::text[]) ORDER BY created_at, operation_id`,
    [query.operationIds],
  );
}
