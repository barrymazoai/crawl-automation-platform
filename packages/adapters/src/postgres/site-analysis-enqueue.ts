import type { SiteAnalysisApplyResult } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";

/** Runs inside the source-apply transaction. Analysis/source identity also deduplicates new request IDs. */
export async function enqueueAnalyzedBrands(
  tx: Queryable,
  analysisId: string,
  result: SiteAnalysisApplyResult,
) {
  result.tasks = [];
  result.notQueued = [];
  const sources = [...result.created, ...result.matched].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const source of sources) {
    const scanId = await enqueueSource(tx, { analysisId, sourceId: source.sourceId });
    if (scanId) {
      result.tasks.push({ ...source, scanId });
    } else {
      result.notQueued.push({ name: source.name, reason: "Source disabled; no task created" });
    }
  }
}

async function enqueueSource(tx: Queryable, input: { analysisId: string; sourceId: string }) {
  const linked = await tx.query<{ scanId: string }>(
    `SELECT scan_id AS "scanId" FROM dtc_analysis_scan WHERE analysis_id=$1 AND source_id=$2`,
    [input.analysisId, input.sourceId],
  );
  if (linked[0]) {
    return linked[0].scanId;
  }
  const rows = await tx.query(
    `INSERT INTO brand_scan (request_id,source_id,channel,url)
     SELECT $1,id,channel,url FROM brand_source WHERE id=$2 AND channel='dtc' AND enabled
     ON CONFLICT (request_id,source_id) DO NOTHING RETURNING scan_id`,
    [input.analysisId, input.sourceId],
  );
  const existing = rows.length
    ? rows
    : await tx.query("SELECT scan_id FROM brand_scan WHERE request_id=$1 AND source_id=$2", [
        input.analysisId,
        input.sourceId,
      ]);
  if (!existing[0]) {
    return null;
  }
  const scanId = z.object({ scan_id: z.uuid() }).parse(existing[0]).scan_id;
  await tx.query(
    "INSERT INTO dtc_analysis_scan (analysis_id,source_id,scan_id) VALUES ($1,$2,$3)",
    [input.analysisId, input.sourceId, scanId],
  );
  return scanId;
}
