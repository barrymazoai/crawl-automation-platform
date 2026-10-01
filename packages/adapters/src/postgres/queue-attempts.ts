import { usageErrors, type QueueAttempt, type QueueAttempts } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

/** Transaction-scoped adapter over the existing 027 history table; never rewrites a prior attempt. */
export class PostgresQueueAttempts implements QueueAttempts {
  constructor(private readonly database: Queryable) {}

  async start(input: Parameters<QueueAttempts["start"]>[0]): Promise<void> {
    const rows = await this.database.query(
      `INSERT INTO queue_attempt (run_id,item_id,channel,attempt) VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING RETURNING run_id`,
      [input.runId, input.itemId, input.channel, input.attempt],
    );
    if (rows.length) {
      return;
    }
    const saved = await this.database.query(
      `SELECT run_id FROM queue_attempt
       WHERE run_id=$1 AND item_id=$2 AND channel=$3 AND attempt=$4`,
      [input.runId, input.itemId, input.channel, input.attempt],
    );
    if (!saved.length) {
      throw usageErrors.create("USAGE.ATTEMPT_CONFLICT");
    }
  }

  async finish(input: Parameters<QueueAttempts["finish"]>[0]): Promise<void> {
    if (input.outcome === "running") {
      throw usageErrors.create("USAGE.ATTEMPT_CONFLICT");
    }
    const values = [input.runId, input.outcome, input.reason];
    const changed = await this.database.query(
      `UPDATE queue_attempt SET outcome=$2,reason=$3,settled_at=clock_timestamp()
       WHERE run_id=$1 AND outcome='running' RETURNING run_id`,
      values,
    );
    if (changed.length) {
      return;
    }
    const matching = await this.database.query(
      `SELECT run_id FROM queue_attempt WHERE run_id=$1 AND outcome=$2
       AND reason IS NOT DISTINCT FROM $3`,
      values,
    );
    if (!matching.length) {
      throw usageErrors.create("USAGE.ATTEMPT_CONFLICT");
    }
  }

  list(itemId: string): Promise<QueueAttempt[]> {
    return this.database.query<QueueAttempt>(
      `SELECT run_id::text AS "runId",item_id AS "itemId",channel,attempt,outcome,reason,
       to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt",
       to_char(settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "settledAt"
       FROM queue_attempt WHERE item_id=$1 ORDER BY attempt`,
      [itemId],
    );
  }
}
