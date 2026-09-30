import { setTimeout as delay } from "node:timers/promises";

// Opaque PostgreSQL timestamp text preserves microseconds for keyset pagination.
export interface ScanCursor { createdAt: string; requestId: string }
export interface DeliveryScan {
  upperBound(): Promise<ScanCursor | null>;
  page(after: ScanCursor | null, through: ScanCursor, limit: number): Promise<ScanCursor[]>;
}
export interface Reconciler { reconcile(requestId: string): Promise<unknown> }
export type RunnerEvent = { event: "RECONCILED" | "RECONCILE_FAILED"; requestId: string } | { event: "SCAN_FAILED" };
export interface RunnerOptions { batchSize: number; concurrency: number; intervalMs: number }

// A reader of accepted handoffs, not an Activity queue, lease or retry scheduler.
// Multiple readers are safe: only the existing journal transaction authorizes Start.
export class DeliveryRunner {
  private after: ScanCursor | null = null;
  private through: ScanCursor | null = null;
  private busy = false;
  constructor(
    private readonly scan: DeliveryScan,
    private readonly coordinator: Reconciler,
    private readonly options: RunnerOptions,
    private readonly paused: () => Promise<boolean>,
    private readonly report: (event: RunnerEvent) => void,
  ) {
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100 ||
        !Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16 ||
        options.concurrency > options.batchSize || !Number.isInteger(options.intervalMs) ||
        options.intervalMs < 100 || options.intervalMs > 60_000) throw new Error("Invalid bounded delivery runner options");
  }

  async tick(signal: AbortSignal): Promise<void> {
    if (this.busy) throw new Error("Overlapping delivery ticks are not allowed");
    this.busy = true;
    try {
      if (signal.aborted || await this.paused()) return;
      // Fixed sweep boundary: new arrivals cannot indefinitely delay an old request's next check.
      if (!this.through) this.through = await this.scan.upperBound();
      if (!this.through || signal.aborted) return;
      const rows = await this.scan.page(this.after, this.through, this.options.batchSize);
      if (rows.length > this.options.batchSize) throw new Error("Unbounded delivery page rejected");
      if (!rows.length) { this.after = null; this.through = null; return; }
      let next = 0;
      const consume = async () => {
        while (!signal.aborted && next < rows.length) {
          if (await this.paused() || signal.aborted) return;
          // No await between selecting and advancing: each page row is assigned once.
          const row = rows[next++];
          if (!row) return;
          this.after = row;
          try {
            await this.coordinator.reconcile(row.requestId);
            this.report({ event: "RECONCILED", requestId: row.requestId });
          } catch {
            // Advance even if identity/DB/remote verification fails. Later rows still run.
            this.report({ event: "RECONCILE_FAILED", requestId: row.requestId });
          }
        }
      };
      // Drain all consumers even if pause-file lookup fails in one of them.
      const results = await Promise.allSettled(Array.from({ length: this.options.concurrency }, consume));
      if (results.some((r) => r.status === "rejected")) throw new Error("Delivery page interrupted");
    } finally { this.busy = false; }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.tick(signal); }
      catch { this.report({ event: "SCAN_FAILED" }); }
      if (!signal.aborted) {
        try { await delay(this.options.intervalMs, undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
      }
    }
  }
}
