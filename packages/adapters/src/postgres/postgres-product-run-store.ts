import {
  appErrors,
  type AcceptedProductRun,
  type ProductRun,
  type ProductRunStore,
  type ProductSource,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";

const SourceRow = z.object({
  brandId: z.string(),
  channel: z.enum(["amazon", "gnc", "swanson", "dtc"]),
});

const RunRow = z.object({
  runId: z.string(),
  workflowId: z.string(),
  channel: z.enum(["amazon", "gnc", "swanson", "dtc"]),
  brandId: z.string(),
  sourceId: z.string(),
  url: z.string(),
  startedRunId: z.string().nullable(),
});

const SELECT_RUN = `
  SELECT run_id AS "runId", workflow_id AS "workflowId", channel, brand_id AS "brandId",
    source_id AS "sourceId", url, started_run_id AS "startedRunId"
  FROM product_run WHERE run_id = $1`;

/** Product runs in `product_run`; each row is written once and only gains its Temporal run ID. */
export class PostgresProductRunStore implements ProductRunStore {
  constructor(private readonly database: Queryable) {}

  async source(sourceId: string): Promise<ProductSource | null> {
    const rows = await this.database.query(
      `SELECT brand_id AS "brandId", channel FROM brand_source WHERE id = $1`,
      [sourceId],
    );
    return rows[0] ? SourceRow.parse(rows[0]) : null;
  }

  async accept(run: ProductRun & ProductSource): Promise<AcceptedProductRun> {
    await this.database.query(
      `INSERT INTO product_run (run_id, source_id, brand_id, channel, url, workflow_id)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (run_id) DO NOTHING`,
      [
        run.requestId,
        run.sourceId,
        run.brandId,
        run.channel,
        run.url,
        `product-run-${run.requestId}`,
      ],
    );
    const stored = RunRow.parse((await this.database.query(SELECT_RUN, [run.requestId]))[0]);
    if (stored.sourceId !== run.sourceId || stored.url !== run.url) {
      throw appErrors.create("REQUEST.ID_CONFLICT", { details: { requestId: run.requestId } });
    }
    return stored;
  }

  async markStarted(runId: string, startedRunId: string): Promise<void> {
    await this.database.query(
      "UPDATE product_run SET started_run_id = $2 WHERE run_id = $1 AND started_run_id IS NULL",
      [runId, startedRunId],
    );
  }
}
