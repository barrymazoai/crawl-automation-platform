import type { ChannelUsage, StepUsage, UsageReader, UsageWindow } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { usageStepQuery, usageSummaryQuery } from "./usage-summary-query.js";

/** A bounded time-window report from one read-only repeatable snapshot. */
export class PostgresUsageReader implements UsageReader {
  constructor(private readonly database: Database) {}

  summarize(window: UsageWindow) {
    return this.database.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const values = [window.from, window.to, window.channel ?? null];
      const channels = await transaction.query<ChannelUsage>(usageSummaryQuery, values);
      const steps = await transaction.query<StepUsage>(usageStepQuery, values);
      const missing = await transaction.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM usage_event
         WHERE started_at >= $1::timestamptz AND started_at < $2::timestamptz AND channel IS NULL`,
        [window.from, window.to],
      );
      return { channels, steps, unattributedEvents: missing[0]?.count ?? 0 };
    });
  }
}
