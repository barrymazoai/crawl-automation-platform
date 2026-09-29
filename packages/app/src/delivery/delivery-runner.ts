import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "@crawl-automation/platform";
import { z } from "zod";
import type { DeliveryScan, ScanCursor } from "./ports.js";

export const DeliveryRunnerOptionsSchema = z
  .strictObject({
    batchSize: z.number().int().min(1).max(100).default(20),
    concurrency: z.number().int().min(1).max(16).default(4),
    intervalMs: z.number().int().min(100).max(60_000).default(1_000),
  })
  .refine((options) => options.concurrency <= options.batchSize, "concurrency exceeds batchSize");
export type DeliveryRunnerOptions = z.infer<typeof DeliveryRunnerOptionsSchema>;

export interface Reconciler {
  reconcile(requestId: string): Promise<unknown>;
}

export interface DeliveryRunnerDeps {
  scan: DeliveryScan;
  coordinator: Reconciler;
  isPaused: () => Promise<boolean>;
  log: Logger;
}

/**
 * Walks the accepted submissions in fixed sweeps and reconciles each one. A sweep boundary is fixed when it
 * starts, so new arrivals cannot keep delaying older requests. Several runners are safe: only the journal
 * transaction authorises a start.
 */
export class DeliveryRunner {
  private after: ScanCursor | null = null;
  private through: ScanCursor | null = null;

  constructor(
    private readonly deps: DeliveryRunnerDeps,
    private readonly options: DeliveryRunnerOptions,
  ) {}

  async tick(signal: AbortSignal): Promise<void> {
    if (signal.aborted || (await this.deps.isPaused())) {
      return;
    }
    this.through ??= await this.deps.scan.upperBound();
    if (!this.through) {
      return;
    }
    const rows = await this.deps.scan.page(this.after, this.through, this.options.batchSize);
    if (rows.length === 0) {
      this.after = null;
      this.through = null;
      return;
    }
    await this.reconcileAll(rows, signal);
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick(signal).catch((error: unknown) => {
        this.deps.log.error({ err: error }, "delivery sweep failed");
      });
      await delay(this.options.intervalMs, undefined, { signal }).catch(() => undefined);
    }
  }

  private async reconcileAll(rows: ScanCursor[], signal: AbortSignal): Promise<void> {
    let next = 0;
    const consume = async () => {
      while (!signal.aborted && next < rows.length && !(await this.deps.isPaused())) {
        const row = rows[next];
        next += 1;
        if (row) {
          this.after = row;
          await this.reconcileOne(row.requestId);
        }
      }
    };
    await Promise.all(Array.from({ length: this.options.concurrency }, consume));
  }

  /** A failure is logged and the sweep moves on; later rows still run. */
  private async reconcileOne(requestId: string): Promise<void> {
    const log = this.deps.log.child({ requestId });
    try {
      await this.deps.coordinator.reconcile(requestId);
      log.debug("delivery reconciled");
    } catch (error) {
      log.warn({ err: error }, "delivery reconcile failed");
    }
  }
}
