const FIRST_WAIT_MS = 60_000;
const LONGEST_WAIT_MS = 60 * 60_000;

interface Wait {
  until: number;
  waitMs: number;
}

/**
 * Remembers requests whose last check failed and holds them back: one minute, then doubling up to an hour.
 * A request that keeps failing (for example one that cannot be routed) no longer spins on every sweep.
 */
export class RetryBackoff {
  private readonly waits = new Map<string, Wait>();

  constructor(private readonly now: () => number = Date.now) {}

  isWaiting(key: string): boolean {
    const wait = this.waits.get(key);
    return wait !== undefined && wait.until > this.now();
  }

  /** Records a failure and returns how long the key now waits. */
  failed(key: string): number {
    const previous = this.waits.get(key)?.waitMs ?? 0;
    const waitMs = Math.min(previous === 0 ? FIRST_WAIT_MS : previous * 2, LONGEST_WAIT_MS);
    this.waits.set(key, { until: this.now() + waitMs, waitMs });
    return waitMs;
  }

  succeeded(key: string): void {
    this.waits.delete(key);
  }
}
