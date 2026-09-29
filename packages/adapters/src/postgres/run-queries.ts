import type { CatalogProgress, RunFilter, RunSummary } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { CollectionSnapshot, DeliveryIssue, ExecutionStatus } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { findProductRun, listProductRuns } from "./product-run-queries.js";

const RunRow = z.object({
  runId: z.string(),
  workflowId: z.string(),
  snapshot: CollectionSnapshot,
  createdAt: z.date(),
  guardHeld: z.boolean(),
  hasDelivery: z.boolean(),
  deliveryRunId: z.string().nullable(),
  observedStatus: ExecutionStatus.nullable(),
  lastIssue: DeliveryIssue.nullable(),
  closedAt: z.date().nullable(),
});

const selectRuns = `
  SELECT r.request_id AS "runId", r.workflow_id AS "workflowId", r.snapshot, r.created_at AS "createdAt",
    g.request_id IS NOT NULL AS "guardHeld", d.request_id IS NOT NULL AS "hasDelivery",
    d.run_id AS "deliveryRunId", d.observed_status AS "observedStatus", d.last_issue AS "lastIssue",
    d.closed_at AS "closedAt"
  FROM collection_submission r
  LEFT JOIN source_submission_guard g ON g.request_id = r.request_id
  LEFT JOIN workflow_delivery d ON d.request_id = r.request_id`;

function toSummary(raw: unknown): RunSummary {
  const row = RunRow.parse(raw);
  const state = row.closedAt ? "CLOSED" : row.deliveryRunId ? "CONFIRMED" : "START_UNKNOWN";
  return {
    kind: "brand",
    runId: row.runId,
    workflowId: row.workflowId,
    channel: row.snapshot.channel,
    brandId: row.snapshot.brandId,
    brandName: row.snapshot.brandName,
    sourceId: row.snapshot.sourceId,
    url: null,
    createdAt: row.createdAt.toISOString(),
    guardHeld: row.guardHeld,
    delivery: row.hasDelivery
      ? {
          state,
          observedStatus: row.observedStatus,
          lastIssue: row.lastIssue,
          closedAt: row.closedAt?.toISOString() ?? null,
        }
      : null,
  };
}

/** Brand and product runs together, newest first. */
export async function listRuns(db: Queryable, filter: RunFilter): Promise<RunSummary[]> {
  const [brands, products] = await Promise.all([
    listBrandRuns(db, filter),
    listProductRuns(db, filter),
  ]);
  return [...brands, ...products]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, filter.limit);
}

async function listBrandRuns(db: Queryable, filter: RunFilter): Promise<RunSummary[]> {
  const rows = await db.query(
    `${selectRuns}
     WHERE ($1::text IS NULL OR r.snapshot->>'channel' = $1)
       AND ($2::text IS NULL OR r.snapshot->>'brandId' = $2)
       AND ($3::boolean IS NULL OR (g.request_id IS NOT NULL) = $3)
     ORDER BY r.created_at DESC LIMIT $4`,
    [filter.channel ?? null, filter.brandId ?? null, filter.active ?? null, filter.limit],
  );
  return rows.map(toSummary);
}

export async function findRun(db: Queryable, runId: string): Promise<RunSummary | null> {
  const rows = await db.query(`${selectRuns} WHERE r.request_id = $1`, [runId]);
  return rows[0] ? toSummary(rows[0]) : findProductRun(db, runId);
}

const Progress = z.object({
  catalogPages: z.number(),
  discovered: z.number(),
  closure: z.enum(["complete", "incomplete"]).nullable(),
  closureFailure: z.string().nullable(),
});

/** A brand run's catalog has the run ID as its catalog ID. */
export async function catalogProgress(db: Queryable, runId: string): Promise<CatalogProgress> {
  const rows = await db.query(
    `SELECT
       (SELECT count(*)::int FROM catalog_page WHERE catalog_id = $1) AS "catalogPages",
       (SELECT count(*)::int FROM catalog_discovery WHERE catalog_id = $1) AS "discovered",
       (SELECT status FROM catalog_closure WHERE catalog_id = $1) AS "closure",
       (SELECT record->>'failure' FROM catalog_closure WHERE catalog_id = $1) AS "closureFailure"`,
    [runId],
  );
  return Progress.parse(rows[0]);
}
