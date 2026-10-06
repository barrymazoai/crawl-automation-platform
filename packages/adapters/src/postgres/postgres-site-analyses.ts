import {
  SiteAnalysisSchema,
  type SiteAnalysisLimits,
  type SiteAnalysisResult,
} from "@crawl-automation/v3-contracts";
import type { Database } from "@crawl-automation/platform";
import {
  SiteAnalysisApplyResultSchema,
  type AnalyzeSiteSchema,
  type ApplySiteAnalysisSchema,
  type SiteAnalysisStore,
} from "@crawl-automation/app";
import type { z } from "zod";
import { oncePerRequest } from "./request-receipt.js";
import { applySiteAnalysis } from "./site-analysis-apply.js";
import { enqueueAnalyzedBrands } from "./site-analysis-enqueue.js";
import { analyzedTasks } from "./site-analysis-tasks.js";

const columns = `id AS "analysisId", url, limits, state, brands, archive_keys AS "archiveKeys", reasons`;
export class PostgresSiteAnalyses implements SiteAnalysisStore {
  constructor(private readonly database: Database) {}
  create(input: z.infer<typeof AnalyzeSiteSchema>, limits: SiteAnalysisLimits) {
    return this.database.transaction((tx) =>
      oncePerRequest(
        tx,
        {
          requestId: input.requestId,
          operation: "brands.analyzeSite",
          input: { url: input.url },
          parse: SiteAnalysisSchema.parse,
        },
        async () => {
          const rows = await tx.query<Record<string, unknown>>(
            `INSERT INTO dtc_site_analysis (id,url,limits) VALUES ($1,$2,$3::jsonb) RETURNING ${columns}`,
            [input.requestId, input.url, JSON.stringify(limits)],
          );
          return SiteAnalysisSchema.parse(rows[0]);
        },
      ),
    );
  }
  async get(analysisId: string) {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${columns} FROM dtc_site_analysis WHERE id=$1`,
      [analysisId],
    );
    return rows[0] ? SiteAnalysisSchema.parse(rows[0]) : null;
  }
  async running(analysisId: string) {
    await this.database.query<Record<string, unknown>>(
      "UPDATE dtc_site_analysis SET state='running',updated_at=clock_timestamp() WHERE id=$1 AND state='queued'",
      [analysisId],
    );
  }
  async evidence(analysisId: string, key: string) {
    await this.database.query<Record<string, unknown>>(
      `UPDATE dtc_site_analysis SET archive_keys=archive_keys || to_jsonb($2::text), updated_at=clock_timestamp()
      WHERE id=$1 AND NOT archive_keys @> jsonb_build_array($2::text)`,
      [analysisId, key],
    );
  }
  async finish(analysisId: string, result: SiteAnalysisResult) {
    await this.database.query<Record<string, unknown>>(
      `UPDATE dtc_site_analysis SET state=$2,brands=$3::jsonb,reasons=$4::jsonb,updated_at=clock_timestamp()
      WHERE id=$1 AND state IN ('queued','running')`,
      [analysisId, result.state, JSON.stringify(result.brands), JSON.stringify(result.reasons)],
    );
  }
  apply(input: z.infer<typeof ApplySiteAnalysisSchema>) {
    const { requestId, ...selection } = input;
    return this.database.transaction((tx) =>
      oncePerRequest(
        tx,
        {
          requestId,
          operation: "brands.applySiteAnalysis",
          input: selection,
          parse: SiteAnalysisApplyResultSchema.parse,
        },
        async () => {
          const result = await applySiteAnalysis(tx, selection);
          if (input.enqueue) {
            await enqueueAnalyzedBrands(tx, input.analysisId, result);
          }
          return result;
        },
      ),
    );
  }
  tasks(analysisId: string) {
    return analyzedTasks(this.database, analysisId);
  }
  async settings(): Promise<unknown[]> {
    const rows = await this.database.query<
      Record<string, unknown>
    >(`SELECT settings FROM dtc_source_settings setting
      JOIN brand_source source ON source.id=setting.source_id
      JOIN brand ON brand.id=source.brand_id
      WHERE source.channel='dtc' AND (
        (source.url=setting.settings->'brands'->0->>'catalogUrl'
          AND lower(brand.name)=lower(setting.settings->'brands'->0->>'brand'))
        OR (setting.settings->>'kind'='single-brand' AND source.url=setting.settings->>'catalogUrl'))
      ORDER BY setting.source_id`);
    return rows.map((row) => row["settings"]);
  }
}
