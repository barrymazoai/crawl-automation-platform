import type { Measurement, MeasurementIdentity, Queryable } from "@crawl-automation/platform";

/** Durable events and owner lookup shared by workers; no Temporal history or log scraping required. */
export class PostgresUsageMeasurements {
  constructor(private readonly database: Queryable) {}

  async resolve(identity: MeasurementIdentity): Promise<MeasurementIdentity> {
    const rows = await this.database.query<{ channel: string; runId: string; sourceId: string }>(
      `SELECT channel, run_id::text AS "runId", source_id::text AS "sourceId"
       FROM product_run WHERE run_id = CASE
         WHEN $1::text ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN $1::uuid END
       OR workflow_id IN ($2,regexp_replace($2,'-label$','')) LIMIT 1`,
      [identity.runId, identity.workflowId],
    );
    const owner = rows[0];
    if (owner) {
      return { ...identity, ...owner };
    }
    const collected = await this.collectionOwner(identity);
    if (collected) {
      return { ...identity, ...collected };
    }
    if (identity.channel || !identity.sourceId) {
      return identity;
    }
    const sources = await this.database.query<{ channel: string }>(
      "SELECT channel FROM brand_source WHERE id::text=$1",
      [identity.sourceId],
    );
    return { ...identity, channel: sources[0]?.channel ?? null };
  }

  private async collectionOwner(identity: MeasurementIdentity) {
    if (identity.runId || !identity.operationId) {
      return null;
    }
    const rows = await this.database.query<{ runId: string; sourceId: string; channel: string }>(
      `SELECT p.run_id::text AS "runId",p.source_id::text AS "sourceId",p.channel
       FROM collected_product c JOIN product_run p
         ON p.run_id::text=c.record->'observation'->>'requestId'
       WHERE c.operation_id=$1 AND ($2::text IS NULL OR p.channel=$2) LIMIT 1`,
      [identity.operationId, identity.channel],
    );
    return rows[0] ?? null;
  }

  async record(event: Measurement): Promise<void> {
    await this.database.query(
      `INSERT INTO usage_event
       (event_id,channel,run_id,operation_id,kind,step,started_at,duration_ms,outcome_code,
        cache_hit,provider_call,credit_cost,input_tokens,output_tokens,record)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.eventId,
        event.channel,
        event.runId,
        event.operationId,
        event.kind,
        event.step,
        event.startedAt,
        event.durationMs,
        event.outcomeCode,
        event.cacheHit,
        event.providerCall,
        event.creditCost,
        event.inputTokens,
        event.outputTokens,
        event,
      ],
    );
  }
}
