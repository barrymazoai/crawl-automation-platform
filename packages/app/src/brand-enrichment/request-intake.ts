import type { Logger } from "@crawl-automation/platform";
import type { BrandEnrichmentRun } from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns, BrandRequestWaits, BrandRequests } from "./ports.js";

/** One request's outcome from the operators' `brandEnrichment.claimPending`. */
export type BrandClaimResult =
  | { requestId: string; runId: string }
  | { requestId: string; skipped: "retail_site"; site: string }
  | { requestId: string; error: string };

export interface BrandRequestIntakeSettings {
  /** Request runs alive at once (owner 2026-10-20: one, raised later). */
  maxLiveRuns: number;
  /** Longest one long poll hangs on Supply Smart (its limit is 25 s). */
  waitMs: number;
  /** A request run still live this long after its claim is stopped and its request failed (owner: 2 h). */
  timeoutMs: number;
}

/** A run stopped for running too long; the mark keeps a second sweep from failing and alerting again. */
const TIMED_OUT = "timed_out";
const TIMEOUT_REASON = "Timeout:";

// The workflow may still move the stage on until the cancel lands; the reason stays until its close.
const timedOut = (run: BrandEnrichmentRun) =>
  run.stage === TIMED_OUT || Boolean(run.failureReason?.startsWith(TIMEOUT_REASON));

/** Where an intake round ended; the worker's loop paces itself on it. */
export type IntakeOutcome = "busy" | "idle" | "claimed" | "stuck";

/**
 * Owner 2026-10-20 (KAN-220): customer brand requests start within seconds, without a person. Supersedes the build
 * plan's manual-start trigger (decision 3) for requests. `listen` is one long-poll round; `sweep` is the low-frequency
 * fallback (lost wake-ups, a long poll that keeps failing) and stops runs that went past the timeout.
 */
export class BrandRequestIntake {
  constructor(
    private readonly deps: {
      waits: BrandRequestWaits;
      requests: Pick<BrandRequests, "update">;
      runs: Pick<BrandEnrichmentRuns, "liveRequestRuns" | "update">;
      /** The operators' API: the same claim and cancel a person uses. */
      api: {
        claimPending(limit: number, signal: AbortSignal): Promise<BrandClaimResult[]>;
        cancel(runId: string, signal: AbortSignal): Promise<void>;
      };
      alerts: { timedOut(run: BrandEnrichmentRun, timeoutMs: number): Promise<void> };
      settings: BrandRequestIntakeSettings;
      log: Pick<Logger, "info" | "warn">;
      now?: () => Date;
    },
  ) {}

  /** The long poll and the fallback round count free slots and claim one at a time, never both into one slot. */
  private turn: Promise<unknown> = Promise.resolve();

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.turn.then(work, work);
    this.turn = result.catch(() => undefined);
    return result;
  }

  /** "busy" when every slot is taken; otherwise waits for a pending request and claims into the free slots. */
  async listen(signal: AbortSignal): Promise<IntakeOutcome> {
    const free = await this.free();
    if (free <= 0) {
      return "busy";
    }
    // The wait itself holds no turn: the fallback round may run meanwhile.
    const pending = await this.deps.waits.waitPending(free, this.deps.settings.waitMs, signal);
    if (pending.length === 0) {
      return "idle";
    }
    return this.exclusive(async () => {
      const now = await this.free();
      return now > 0 ? this.claim(now, "long_poll", signal) : "busy";
    });
  }

  /** Fallback round: time out stuck runs, then claim whatever is pending into the free slots. */
  async sweep(signal: AbortSignal): Promise<void> {
    await this.exclusive(async () => {
      await this.timeOut(signal);
      const free = await this.free();
      if (free > 0) {
        await this.claim(free, "fallback", signal);
      }
    });
  }

  private async free() {
    const live = await this.live();
    return this.deps.settings.maxLiveRuns - live.length;
  }

  /** A timed-out run no longer holds a slot: its request has already failed, only the stop may still be pending. */
  private async live() {
    return (await this.deps.runs.liveRequestRuns()).filter((run) => !timedOut(run));
  }

  private async claim(limit: number, via: string, signal: AbortSignal): Promise<IntakeOutcome> {
    const results = await this.deps.api.claimPending(limit, signal);
    const started = results.filter((item) => "runId" in item);
    const skipped = results.filter((item) => "skipped" in item);
    const errors = results.filter((item) => "error" in item);
    if (results.length > 0) {
      this.deps.log.info(
        { via, started, skipped, errors: errors.slice(0, 5) },
        "brand requests claimed",
      );
    }
    // Pending requests that all failed to start would come straight back from the next long poll.
    return results.length > 0 && errors.length === results.length ? "stuck" : "claimed";
  }

  private async timeOut(signal: AbortSignal) {
    const now = (this.deps.now ?? (() => new Date()))().getTime();
    const runs = await this.deps.runs.liveRequestRuns();
    for (const run of runs) {
      if (now - run.createdAt.getTime() < this.deps.settings.timeoutMs) {
        continue;
      }
      signal.throwIfAborted();
      try {
        if (!timedOut(run)) {
          await this.failTimedOut(run, signal);
        }
        await this.deps.api.cancel(run.runId, signal);
      } catch (error) {
        signal.throwIfAborted();
        this.deps.log.warn({ runId: run.runId, err: error }, "brand request timeout not finished");
      }
    }
  }

  /** Request failed first, so the run's own close (cancelled → failed) is a no-op on Supply Smart. */
  private async failTimedOut(run: BrandEnrichmentRun, signal: AbortSignal) {
    const hours = Math.round((this.deps.settings.timeoutMs / 3_600_000) * 10) / 10;
    const reason = `${TIMEOUT_REASON} still in progress after ${hours} h; crawler run ${run.runId} stopped (stage ${run.stage ?? "unknown"}).`;
    if (run.requestId) {
      await this.deps.requests.update({ id: run.requestId, status: "failed", reason }, signal);
    }
    await this.deps.runs.update(run.runId, { stage: TIMED_OUT, failureReason: reason });
    this.deps.log.warn({ runId: run.runId, requestId: run.requestId }, "brand request timed out");
    try {
      await this.deps.alerts.timedOut(run, this.deps.settings.timeoutMs);
    } catch (error) {
      this.deps.log.warn({ runId: run.runId, err: error }, "brand request timeout alert failed");
    }
  }
}
