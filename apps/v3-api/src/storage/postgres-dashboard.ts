import type pg from "pg";
import { DashboardSummarySchema, DashboardProductsSchema, TemporalUi, CatalogExecutionSchema,
  ExecutionIdSchema, ObservationSchema, type DashboardSummary } from "@crawl-automation/v3-contracts";
export interface DashboardReader {
  summary(): Promise<DashboardSummary>;
  products(before?: string): Promise<ReturnType<typeof DashboardProductsSchema.parse>>;
}
/** Read-only business-ledger queries; never use Temporal visibility totals as product counts. */
export class PostgresDashboard implements DashboardReader {
  constructor(private readonly db: Pick<pg.Pool, "query">, private readonly ui: { clusterId: string; baseUrl: string }[] = []) {
    ui.forEach(x => TemporalUi.parse(x));
  }
  async summary() {
    const { rows } = await this.db.query(`SELECT now() AS at,
      (SELECT count(*)::int FROM catalog_discovery) AS discoveries,
      (SELECT count(*)::int FROM catalog_dispatch) AS dispatched,
      (SELECT count(*)::int FROM catalog_discovery d LEFT JOIN catalog_dispatch x USING(discovery_id) WHERE x.discovery_id IS NULL) AS pending,
      (SELECT count(*)::int FROM processing_result) AS results,
      (SELECT count(DISTINCT coalesce(record->'input'->>'observationId',record->'input'->'input'->'selection'->'observation'->>'observationId'))::int FROM processing_result) AS processed,
      (SELECT count(*)::int FROM collected_product) AS collected,
      (SELECT count(DISTINCT observation_id)::int FROM collected_product) AS collected_observations,
      (SELECT count(*)::int FROM review_record) AS reviews,
      (SELECT count(DISTINCT record->'failure'->>'observationId')::int FROM review_record) AS review_observations,
      (SELECT count(*)::int FROM catalog_run r LEFT JOIN catalog_closure c USING(catalog_id) WHERE c.catalog_id IS NULL) AS open,
      (SELECT count(*)::int FROM catalog_closure WHERE status='complete') AS complete,
      (SELECT count(*)::int FROM catalog_closure WHERE status='incomplete') AS incomplete,
      (SELECT count(*)::int FROM collection_submission s LEFT JOIN workflow_delivery d USING(request_id) WHERE d.request_id IS NULL) AS waiting,
      (SELECT count(*)::int FROM workflow_delivery WHERE run_id IS NULL OR last_issue IS NOT NULL) AS unknown,
      (SELECT coalesce(jsonb_agg(e),'[]'::jsonb) FROM (SELECT record->'failure'->>'category' AS category,record->'failure'->>'code' AS code,count(*)::int AS count
        FROM (SELECT record FROM review_record UNION ALL
          SELECT jsonb_build_object('failure',jsonb_build_object('category','CATALOG','code',record->>'failure')) FROM catalog_closure WHERE status='incomplete') failures
        GROUP BY 1,2 ORDER BY count(*) DESC,1,2 LIMIT 200) e) AS errors,
      (SELECT coalesce(jsonb_agg(s),'[]'::jsonb) FROM (SELECT source_id AS "sourceId",sum(collected)::int AS collected,sum(reviews)::int AS reviews FROM (
        SELECT record->'observation'->>'sourceId' AS source_id,count(*)::int AS collected,0 AS reviews FROM collected_product GROUP BY 1
        UNION ALL SELECT coalesce(record->'observation'->>'sourceId','unassigned'),0,count(*)::int FROM review_record GROUP BY 1
      ) x GROUP BY source_id ORDER BY source_id LIMIT 200) s) AS sources`);
    const r = rows[0];
    return DashboardSummarySchema.parse({ asOf: r.at.toISOString(), basis: "business-database", discoveries: r.discoveries,
      dispatchedProducts: r.dispatched, pendingDispatches: r.pending, processingResults: r.results, processedObservations: r.processed,
      collectedProducts: r.collected, collectedObservations: r.collected_observations, reviews: r.reviews, reviewObservations: r.review_observations,
      formalWrites: null, formalWriteStatus: "not-connected", catalogs: { open: r.open, complete: r.complete, incomplete: r.incomplete },
      handoff: { waiting: r.waiting, unknown: r.unknown }, errors: r.errors, sources: r.sources });
  }
  async products(before?: string) {
    if (before) ExecutionIdSchema.parse(before);
    const rows = (await this.db.query(`SELECT p.*,x.execution FROM collected_product p LEFT JOIN LATERAL (
      SELECT execution FROM observation_execution e WHERE e.observation_id=p.observation_id ORDER BY registered_at DESC,execution->>'runId' DESC LIMIT 1
    ) x ON true WHERE ($1::text IS NULL OR p.operation_id<$1) ORDER BY p.operation_id DESC LIMIT 26`, [before ?? null])).rows;
    const items = rows.slice(0,25).map(r => {
      const p = r.record, observation = ObservationSchema.parse(p.observation);
      let temporalUrl: string | null = null;
      if (r.execution) {
        const e = CatalogExecutionSchema.parse(r.execution), base = this.ui.find(ui => ui.clusterId === e.clusterId)?.baseUrl;
        if (base) temporalUrl = `${base.replace(/\/$/, "")}/namespaces/${encodeURIComponent(e.namespace)}/workflows/${encodeURIComponent(e.workflowId)}/${e.runId}/history`;
      }
      return { operationId: r.operation_id, observation, collectedAt: r.collected_at.toISOString(), recordHash: r.record_hash,
        formulaRows: p.formula?.columns?.reduce((n: number, c: { rows: unknown[] }) => n + c.rows.length, 0) ?? p.formula?.rows?.length ?? 0,
        otherIngredients: p.otherIngredients?.items?.length ?? 0, warningCodes: (p.warnings ?? []).map((w: { code: string }) => w.code), temporalUrl };
    });
    return DashboardProductsSchema.parse({ items, nextCursor: rows.length > 25 ? items.at(-1)!.operationId : null });
  }
}
