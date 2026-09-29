import type { RunFilter, RunSummary } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";

const ProductRunRow = z.object({
  runId: z.string(),
  workflowId: z.string(),
  channel: z.enum(["amazon", "gnc", "swanson", "dtc"]),
  brandId: z.string(),
  brandName: z.string(),
  sourceId: z.string(),
  url: z.string(),
  createdAt: z.date(),
  startedRunId: z.string().nullable(),
});

const selectProductRuns = `
  SELECT p.run_id::text AS "runId", p.workflow_id AS "workflowId", p.channel, p.brand_id::text AS "brandId",
    b.name AS "brandName", p.source_id::text AS "sourceId", p.url, p.created_at AS "createdAt",
    p.started_run_id AS "startedRunId"
  FROM product_run p JOIN brand b ON b.id = p.brand_id`;

/** A product run holds no source guard; its progress is its workflows, shown by `runs.get`. */
function toSummary(raw: unknown): RunSummary {
  const row = ProductRunRow.parse(raw);
  return {
    kind: "product",
    runId: row.runId,
    workflowId: row.workflowId,
    channel: row.channel,
    brandId: row.brandId,
    brandName: row.brandName,
    sourceId: row.sourceId,
    url: row.url,
    createdAt: row.createdAt.toISOString(),
    guardHeld: false,
    delivery: {
      state: row.startedRunId ? "CONFIRMED" : "START_UNKNOWN",
      observedStatus: null,
      lastIssue: null,
      closedAt: null,
    },
  };
}

/** Product runs matching the filter; none is "active" in the guard sense. */
export async function listProductRuns(db: Queryable, filter: RunFilter): Promise<RunSummary[]> {
  if (filter.active === true) {
    return [];
  }
  const rows = await db.query(
    `${selectProductRuns}
     WHERE ($1::text IS NULL OR p.channel = $1) AND ($2::uuid IS NULL OR p.brand_id = $2)
     ORDER BY p.created_at DESC LIMIT $3`,
    [filter.channel ?? null, filter.brandId ?? null, filter.limit],
  );
  return rows.map(toSummary);
}

export async function findProductRun(db: Queryable, runId: string): Promise<RunSummary | null> {
  if (!z.uuid().safeParse(runId).success) {
    return null;
  }
  const rows = await db.query(`${selectProductRuns} WHERE p.run_id = $1`, [runId]);
  return rows[0] ? toSummary(rows[0]) : null;
}
