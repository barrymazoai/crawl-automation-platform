import { setTimeout as delay } from "node:timers/promises";
import { errorCodeOf, isAppError, type Logger } from "@crawl-automation/platform";
import { z } from "zod";
import {
  settledOutcome,
  type DispatchStore,
  type ProductStarter,
  type QueueControl,
  type RunCanceller,
  type RunExecutions,
  type StartedItem,
} from "./dispatch-model.js";

export const QueueDispatcherOptionsSchema = z.strictObject({
  intervalMs: z.number().int().min(500).max(60_000).default(5_000),
});
export type QueueDispatcherOptions = z.infer<typeof QueueDispatcherOptionsSchema>;

export interface QueueDispatcherDeps {
  store: DispatchStore;
  executions: RunExecutions;
  starter: ProductStarter;
  canceller: RunCanceller;
  /** While true, nothing new starts; running items are still settled. */
  isPaused: () => Promise<boolean>;
  log: Logger;
}

/** A start refused for good (bad source, channel not set up): the item becomes a Review with that code. */
const REFUSED = new Set(["VALIDATION", "IDENTITY"]);

/**
 * The queue dispatcher of every channel, run by the API process like the delivery runner. Each round: settle the
 * items whose product run ended, then (for a running channel) fill `ready` and start products up to the running
 * limit. A product is started once; a failed product becomes a Review and is only started again by a requeue.
 */
export class QueueDispatcher {
  constructor(
    private readonly deps: QueueDispatcherDeps,
    private readonly options: QueueDispatcherOptions,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick(signal);
      } catch (error) {
        // One failed round never stops the queue; the next round starts from the tables again.
        this.deps.log.error({ err: error, code: errorCodeOf(error) }, "queue round failed");
      }
      await delay(this.options.intervalMs, undefined, { signal }).catch(() => undefined);
    }
  }

  async tick(signal: AbortSignal): Promise<void> {
    const paused = await this.deps.isPaused();
    for (const control of await this.deps.store.controls()) {
      if (signal.aborted) {
        return;
      }
      await this.settleRunning(control);
      if (control.mode === "running" && !paused) {
        await this.startMore(control);
      } else if (control.mode !== "running") {
        await this.deps.store.pauseIfIdle(control.channel);
      }
    }
  }

  private async settleRunning(control: QueueControl): Promise<void> {
    for (const item of await this.deps.store.running(control.channel)) {
      const execution = await this.deps.executions.execution(item.runId);
      const outcome = settledOutcome(execution);
      if (outcome) {
        await this.deps.store.settle(item, outcome);
        this.deps.log.info({ ...identity(item), ...outcome }, "queue item settled");
      } else if (execution.status === "MISSING") {
        await this.finishStart(control, item);
      } else if (control.mode === "stopping" && !item.stopRequested) {
        await this.stop(item);
      }
    }
  }

  /** A claimed item whose run never started: start it (same request, so never twice), unless the queue stops. */
  private async finishStart(control: QueueControl, item: StartedItem): Promise<void> {
    if (control.mode === "stopping") {
      await this.deps.store.settle(item, { state: "review", reason: "QUEUE.STOPPED_BEFORE_START" });
      return;
    }
    await this.start(item);
  }

  private async startMore(control: QueueControl): Promise<void> {
    await this.deps.store.fillReady(control);
    for (const item of await this.deps.store.claim(control)) {
      await this.start(item);
    }
  }

  /**
   * Starts the item's product run under its own run ID. A refusal is final and recorded; any other failure leaves
   * the item running, and the next round finishes the same start (the run ID makes a second start impossible).
   */
  private async start(item: StartedItem): Promise<void> {
    const run = {
      kind: "product" as const,
      requestId: item.runId,
      sourceId: item.sourceId,
      url: item.url,
    };
    try {
      await this.deps.starter.submit(run);
      this.deps.log.info(identity(item), "queue item started");
    } catch (error) {
      if (isAppError(error) && REFUSED.has(error.category)) {
        await this.deps.store.settle(item, { state: "review", reason: error.code });
        this.deps.log.warn({ ...identity(item), code: error.code }, "queue item refused");
        return;
      }
      this.deps.log.warn(
        { ...identity(item), err: error, code: errorCodeOf(error) },
        "start unconfirmed",
      );
    }
  }

  /** A forced stop cancels the run's workflows once; the item settles when they have ended. */
  private async stop(item: StartedItem): Promise<void> {
    try {
      await this.deps.canceller.cancel(item.runId);
      await this.deps.store.markStopRequested(item);
      this.deps.log.info(identity(item), "queue item stop requested");
    } catch (error) {
      this.deps.log.warn(
        { ...identity(item), err: error, code: errorCodeOf(error) },
        "stop failed",
      );
    }
  }
}

function identity(item: StartedItem) {
  return { channel: item.channel, itemId: item.itemId, runId: item.runId };
}
