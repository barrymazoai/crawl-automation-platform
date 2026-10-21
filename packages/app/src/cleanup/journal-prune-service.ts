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
  /**
   * How often the scheduled run, which removes files, starts: on every multiple of this from midnight UTC
   * (3,600,000 = every full hour). Null runs only when started through the API.
   */
  intervalMs: number | null;
  now?: () => Date;
}

export interface JournalPruneStatus {
  running: { removeFiles: boolean; startedAt: string } | null;
  last: JournalPruneReport | null;
  lastError: string | null;
}

/**
 * Owner 2026-10-19: this machine's copies of original pages are removed after R2 is checked to hold the same
 * bytes. Owner 2026-10-21: on a fixed interval (every hour on Server 一) instead of once a day, so the copies never
 * pile up for two days. One prune at a time; the last result stays readable until the API restarts.
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
    const interval = this.deps.intervalMs;
    if (interval === null) {
      return;
    }
    while (!signal.aborted) {
      const ok = await delay(untilNextTick(this.now(), interval), true, { signal }).catch(
        ignoreAbort,
      );
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

/** Milliseconds until the next multiple of `intervalMs` from midnight UTC; a tick on the dot waits a full interval. */
export function untilNextTick(now: Date, intervalMs: number): number {
  return intervalMs - (now.getTime() % intervalMs);
}
