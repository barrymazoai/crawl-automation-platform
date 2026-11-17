import type { Queryable, UsageRetentionReport } from "@crawl-automation/platform";

/**
 * Owner 2026-11-17: `usage_event` grew ~0.75G a day, nine tenths of it per-step timing rows (`activity`) and reuse
 * rows (`preparation`) that only serve "which step is slow" checks of the last days. Rows of the named kinds older
 * than the retention go; cost rows (captures, model calls, OCR, brand requests) are never named here and stay.
 */
export interface UsageRetentionInput {
  kinds: readonly string[];
  keepDays: number;
  /** At most this many rows go in one pass; a backlog is worked off over the following runs. */
  maxRows: number;
  /** False previews: rows are counted, nothing is removed. */
  removeRows: boolean;
}

/** Rows removed per statement: each batch commits on its own, so no lock or transaction is held for long. */
const BATCH_ROWS = 50_000;

/** The partial index `usage_event_retention` (078) covers exactly these rows; the literal list lets it be used. */
const REMOVABLE =
  "kind IN ('activity', 'preparation') AND kind = ANY($1::text[]) AND started_at < $2::timestamptz";

export class PostgresUsageRetention {
  constructor(
    private readonly database: Queryable,
    private readonly deps: { now: () => Date } = { now: () => new Date() },
  ) {}

  /** Never throws: a failure is reported with the rows already removed, so the rest of the cleanup still reports. */
  async prune(input: UsageRetentionInput, signal: AbortSignal): Promise<UsageRetentionReport> {
    const kinds = [...input.kinds];
    const before = new Date(this.deps.now().getTime() - input.keepDays * 86_400_000).toISOString();
    const report: UsageRetentionReport = { kinds, before, older: 0, removed: 0, limited: false };
    try {
      const [counted] = await this.database.query<{ rows: number }>(
        `SELECT count(*)::int AS rows FROM usage_event WHERE ${REMOVABLE}`,
        [kinds, before],
      );
      report.older = counted?.rows ?? 0;
      if (input.removeRows) {
        await this.remove(report, input.maxRows, signal);
      } else {
        report.removed = Math.min(report.older, input.maxRows);
      }
      report.limited = report.removed < report.older && report.removed >= input.maxRows;
    } catch (error) {
      report.error = String(error);
    }
    return report;
  }

  private async remove(report: UsageRetentionReport, maxRows: number, signal: AbortSignal) {
    while (report.removed < maxRows) {
      signal.throwIfAborted();
      const batch = Math.min(BATCH_ROWS, maxRows - report.removed);
      const [gone] = await this.database.query<{ rows: number }>(
        `WITH gone AS (
           DELETE FROM usage_event WHERE event_id IN (
             SELECT event_id FROM usage_event WHERE ${REMOVABLE} LIMIT $3)
           RETURNING 1)
         SELECT count(*)::int AS rows FROM gone`,
        [report.kinds, report.before, batch],
      );
      const removed = gone?.rows ?? 0;
      report.removed += removed;
      if (removed < batch) {
        return;
      }
    }
  }
}
