import type { Withdraw, WithdrawResult } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

interface Candidate {
  itemId: string;
  batchId: string;
  label: string;
  state: string;
  runId: string | null;
  openAttempt: boolean;
}

/** Called under the channel queue lock; preview and mutation inspect the same scoped rows. */
export class PostgresQueueWithdraw {
  constructor(private readonly tx: Queryable) {}

  async withdraw(input: Withdraw): Promise<WithdrawResult> {
    const ids = [...new Set(input.batchIds ?? input.itemIds ?? [])];
    const rows = await this.candidates(input, ids);
    const found = await this.foundSelectors(input, ids, rows.length);
    const eligible = rows.filter(eligibleToWithdraw);
    if (!input.dryRun && eligible.length) {
      await this.update(input, eligible);
    }
    return resultOf(rows, eligible, { dryRun: input.dryRun, notFound: ids.length - found });
  }

  private candidates(input: Withdraw, ids: string[]): Promise<Candidate[]> {
    const selector =
      input.batchIds === undefined ? "q.item_id = ANY($2::text[])" : "q.batch_id = ANY($2::uuid[])";
    return this.tx.query<Candidate>(
      `SELECT q.item_id AS "itemId", q.batch_id::text AS "batchId", b.label, q.state,
         q.run_id::text AS "runId", EXISTS (
           SELECT 1 FROM queue_attempt a WHERE a.item_id = q.item_id AND a.outcome = 'running'
         ) AS "openAttempt"
       FROM queue_item q JOIN link_batch b ON b.batch_id = q.batch_id
       WHERE q.channel = $1 AND ${selector}
       ORDER BY q.batch_id, q.item_id FOR UPDATE OF q`,
      [input.channel, ids],
    );
  }

  private async foundSelectors(input: Withdraw, ids: string[], itemCount: number): Promise<number> {
    if (input.batchIds === undefined) {
      return itemCount;
    }
    const rows = await this.tx.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM link_batch WHERE channel = $1 AND batch_id = ANY($2::uuid[])",
      [input.channel, ids],
    );
    return rows[0]?.count ?? 0;
  }

  private async update(input: Withdraw, eligible: Candidate[]): Promise<void> {
    const updated = await this.tx.query<{ item_id: string }>(
      `UPDATE queue_item q SET state = 'withdrawn', reason = 'QUEUE.WITHDRAWN',
         withdraw_note = $3, withdrawn_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE q.channel = $1 AND q.item_id = ANY($2::text[])
         AND q.state IN ('queued', 'ready', 'following') AND q.run_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM queue_attempt a
           WHERE a.item_id = q.item_id AND a.outcome = 'running')
       RETURNING q.item_id`,
      [input.channel, eligible.map((row) => row.itemId), input.reason ?? null],
    );
    if (updated.length !== eligible.length) {
      throw new Error("Queue withdrawal selection changed under the channel lock");
    }
  }
}

function eligibleToWithdraw(row: Candidate): boolean {
  return (
    ["queued", "ready", "following"].includes(row.state) && row.runId === null && !row.openAttempt
  );
}

function stillRunning(row: Candidate): boolean {
  return (
    row.state === "running" ||
    row.openAttempt ||
    (["queued", "ready", "following"].includes(row.state) && row.runId !== null)
  );
}

function resultOf(
  rows: Candidate[],
  eligible: Candidate[],
  options: { dryRun: boolean; notFound: number },
): WithdrawResult {
  const running = rows.filter(stillRunning).length;
  const byBatch = new Map<string, { batchId: string; label: string; count: number }>();
  for (const row of eligible) {
    const batch = byBatch.get(row.batchId) ?? { batchId: row.batchId, label: row.label, count: 0 };
    batch.count++;
    byBatch.set(row.batchId, batch);
  }
  return {
    dryRun: options.dryRun,
    matched: rows.length,
    withdrawn: eligible.length,
    skipped: {
      running,
      settled: rows.length - eligible.length - running,
      notFound: options.notFound,
    },
    byBatch: [...byBatch.values()],
  };
}
