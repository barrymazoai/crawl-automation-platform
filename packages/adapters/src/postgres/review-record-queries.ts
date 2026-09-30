import type { ReviewListQuery } from "@crawl-automation/v3-contracts";

/** A stored Review row of `review_record`. */
export interface ReviewRow {
  review_id: string;
  record_hash: string;
  record: unknown;
  registered_at: Date;
}

export const SELECT_REVIEW = "SELECT * FROM public.review_record WHERE review_id=$1";

export const INSERT_REVIEW = `INSERT INTO public.review_record(review_id,record_hash,record)
  VALUES($1,$2,$3::jsonb) ON CONFLICT(review_id) DO NOTHING`;

export const SUMMARY_REVIEWS = `SELECT record->'failure'->>'category' AS category, count(*)::text AS count
  FROM public.review_record GROUP BY 1 ORDER BY 1`;

const FILTERS = [
  "requestId",
  "operationId",
  "category",
  "code",
  "stage",
  "executionFact",
  "blockedBy",
  "brandId",
  "sourceId",
] as const;

/**
 * One page of Reviews, newest ID first. Paging by the immutable opaque ID avoids precision loss from timestamp
 * cursors. The filter keys are a fixed list, so only values are parameters.
 */
export function listReviewsQuery(query: ReviewListQuery): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const where: string[] = [];
  if (query.before) {
    params.push(query.before);
    where.push(`review_id < $${params.length}`);
  }
  for (const key of FILTERS) {
    if (query[key] === undefined) {
      continue;
    }
    params.push(query[key]);
    const group = key === "brandId" || key === "sourceId" ? "observation" : "failure";
    where.push(`record->'${group}'->>'${key}' = $${params.length}`);
  }
  params.push(query.limit + 1);
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT * FROM public.review_record ${filter} ORDER BY review_id DESC LIMIT $${params.length}`;
  return { sql, params };
}
