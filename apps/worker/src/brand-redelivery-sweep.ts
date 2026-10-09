import { setTimeout } from "node:timers/promises";
import type { BrandRedeliverySweep } from "@crawl-automation/app";
import { ignoreAbort, type Logger } from "@crawl-automation/platform";
import type { WorkerParts } from "./container.js";

/** Hosted only by the brand-enrichment role, with the same lifetime as its Temporal workers. */
export async function runBrandRedeliverySweep(parts: WorkerParts, signal: AbortSignal) {
  const settings = parts.config.brandEnrichment;
  if (!settings || settings.limits.redeliverySweepMinutes === 0) {
    return;
  }
  await brandRedeliverySweepLoop({
    sweep: async (signal) => (await parts.brandEnrichment).redeliverySweep.sweep(signal),
    log: parts.log.child({ service: "brand-redelivery-sweep" }),
    intervalMs: settings.limits.redeliverySweepMinutes * 60_000,
    signal,
  });
}

export async function brandRedeliverySweepLoop(input: {
  sweep: BrandRedeliverySweep["sweep"];
  log: Logger;
  intervalMs: number;
  signal: AbortSignal;
}): Promise<void> {
  if (input.intervalMs === 0) {
    return;
  }
  try {
    while (!input.signal.aborted) {
      try {
        await input.sweep(input.signal);
      } catch (error) {
        input.signal.throwIfAborted();
        input.log.warn({ err: error }, "brand redelivery sweep failed");
      }
      await setTimeout(input.intervalMs, undefined, { signal: input.signal });
    }
  } catch (error) {
    if (!input.signal.aborted) {
      ignoreAbort(error);
    }
  }
}
