import { SiteAnalysisTaskProgressSchema } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

export async function analyzedTasks(database: Queryable, analysisId: string) {
  const rows = await database.query(
    `SELECT brand.name,brand.id AS "brandId",source.id AS "sourceId",scan.scan_id AS "scanId",
      scan.url AS "catalogUrl",scan.state,scan.code,
      coalesce((scan.result->>'full')::boolean,false) AS "catalogComplete",
      coalesce((scan.result->>'products')::integer,0) AS discovered,
      coalesce((SELECT jsonb_object_agg(counts.state,counts.total)
        FROM (SELECT item.state,count(*)::integer AS total FROM queue_item item
          WHERE item.batch_id=scan.scan_id AND item.source_id=source.id GROUP BY item.state) counts),
        '{}'::jsonb) AS products
     FROM dtc_analysis_scan link JOIN brand_scan scan ON scan.scan_id=link.scan_id
     JOIN brand_source source ON source.id=link.source_id JOIN brand ON brand.id=source.brand_id
     WHERE link.analysis_id=$1 ORDER BY scan.requested_at,scan.scan_id`,
    [analysisId],
  );
  return rows.map((row) => SiteAnalysisTaskProgressSchema.parse(row));
}
