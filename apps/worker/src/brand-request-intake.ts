import { setTimeout } from "node:timers/promises";
import type { IntakeOutcome } from "@crawl-automation/app";
import { ignoreAbort, type Logger } from "@crawl-automation/platform";
import type { WorkerParts } from "./container.js";
import { brandRedeliverySweepLoop } from "./brand-redelivery-sweep.js";

/** A round whose pending requests all failed to start waits this long, so it does not spin on them. */
const STUCK_PAUSE_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

/** The long poll and the fallback round, with the lifetime of the brand-enrichment worker. */
export async function runBrandRequestIntake(parts: WorkerParts, signal: AbortSignal) {
  const settings = parts.config.brandEnrichment?.requestIntake;
  if (!settings?.enabled) {
    return;
  }
  const intake = (await parts.brandEnrichment).requestIntake;
  if (!intake) {
    parts.log.warn("brand request intake enabled but no operators' API URL; intake stays manual");
    return;
  }
  const log = parts.log.child({ service: "brand-request-intake" });
  await Promise.all([
    listenLoop({
      listen: (loopSignal) => intake.listen(loopSignal),
      log,
      busyMs: settings.busySeconds * 1_000,
      signal,
    }),
    brandRedeliverySweepLoop({
      sweep: (loopSignal) => intake.sweep(loopSignal),
      log,
      intervalMs: settings.fallbackMinutes * 60_000,
      signal,
    }),
  ]);
}

/** Back to back long polls; a full house or a failing round waits, with backoff on errors up to a minute. */
export async function listenLoop(input: {
  listen: (signal: AbortSignal) => Promise<IntakeOutcome>;
  log: Pick<Logger, "warn">;
  busyMs: number;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<unknown>;
}): Promise<void> {
  const sleep = input.sleep ?? ((ms, signal) => setTimeout(ms, undefined, { signal }));
  let backoffMs = 0;
  try {
    while (!input.signal.aborted) {
      let pauseMs = 0;
      try {
        const outcome = await input.listen(input.signal);
        backoffMs = 0;
        pauseMs = outcome === "busy" ? input.busyMs : outcome === "stuck" ? STUCK_PAUSE_MS : 0;
      } catch (error) {
        input.signal.throwIfAborted();
        backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(5_000, backoffMs * 2));
        pauseMs = backoffMs;
        input.log.warn({ err: error, retryInMs: backoffMs }, "brand request long poll failed");
      }
      if (pauseMs > 0) {
        await sleep(pauseMs, input.signal);
      }
    }
  } catch (error) {
    if (!input.signal.aborted) {
      ignoreAbort(error);
    }
  }
}
