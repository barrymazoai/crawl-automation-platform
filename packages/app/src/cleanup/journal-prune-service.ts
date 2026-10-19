import { setTimeout as delay } from "node:timers/promises";
import {
  errorCodeOf,
  ignoreAbort,
  type JournalPruneReport,
  type Logger,
} from "@crawl-automation/platform";
import { z } from "zod";
import { appErrors } from "../errors.js";

export const JournalPruneStartSchema = z.strictObject({
  /** True (the default) only counts what would go. */
  dryRun: z.boolean().default(true),
});
export type JournalPruneStart = z.input<typeof JournalPruneStartSchema>;

export interface JournalPruneDeps {
  prune(removeFiles: boolean, signal: AbortSignal): Promise<JournalPruneReport>;
  log: Logger;
  /** UTC hour of the daily run, which removes files; null runs only when started through the API. */
  dailyAtUtcHour: number | null;
  now?: () => Date;
}

export interface JournalPruneStatus {
  running: { removeFiles: boolean; startedAt: string } | null;
  last: JournalPruneReport | null;
  lastError: string | null;
}

/**
 * Owner 2026-10-19: this machine's copies of original pages are removed once a day after R2 is checked to hold the
 * same bytes. One prune at a time; the last result stays readable until the API restarts.
 */
export class JournalPruneService {
  private running: JournalPruneStatus["running"] = null;
  private last: JournalPruneReport | null = null;
  private lastError: string | null = null;
  private lifetime = new AbortController().signal;

  constructor(private readonly deps: JournalPruneDeps) {}

  status(): JournalPruneStatus {
    return { running: this.running, last: this.last, lastError: this.lastError };
  }

  /** Starts one prune in the background and answers at once; `status` shows its result. */
  start(raw: JournalPruneStart): JournalPruneStatus {
    const input = JournalPruneStartSchema.parse(raw);
    if (this.running) {
      throw appErrors.create("JOURNAL_PRUNE.BUSY");
    }
    void this.prune(!input.dryRun);
    return this.status();
  }

  async run(signal: AbortSignal): Promise<void> {
    this.lifetime = signal;
    const hour = this.deps.dailyAtUtcHour;
    if (hour === null) {
      return;
    }
    while (!signal.aborted) {
      const ok = await delay(untilNextHour(this.now(), hour), true, { signal }).catch(ignoreAbort);
      if (ok && !this.running) {
        await this.prune(true);
      }
    }
  }

  private async prune(removeFiles: boolean): Promise<void> {
    this.running = { removeFiles, startedAt: this.now().toISOString() };
    try {
      this.last = await this.deps.prune(removeFiles, this.lifetime);
      this.lastError = null;
      this.deps.log.info({ report: this.last }, "journal prune finished");
    } catch (error) {
      this.lastError = String(error);
      this.deps.log.error({ err: error, code: errorCodeOf(error) }, "journal prune failed");
    } finally {
      this.running = null;
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

export function untilNextHour(now: Date, utcHour: number): number {
  const next = new Date(now);
  next.setUTCHours(utcHour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}
