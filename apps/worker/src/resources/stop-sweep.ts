import { setTimeout } from "node:timers/promises";
import { ResourcesApi } from "@crawl-automation/adapters";
import { ignoreAbort, type Logger } from "@crawl-automation/platform";
import type { CoreParts } from "../core-parts.js";

export async function runStopSweep(parts: CoreParts, signal: AbortSignal): Promise<void> {
  const settings = parts.config.stopSweep;
  if (!settings) {
    // The sweep is global: one machine (Server 一, next to the API) runs it. A resources role elsewhere
    // (Server 二's local browser health) runs without it.
    parts.log.warn(
      { role: "resources", section: "stopSweep" },
      "permit stop sweep not configured here",
    );
    return;
  }
  await stopSweepLoop({
    api: new ResourcesApi(settings.apiUrl),
    log: parts.log.child({ service: "permit-stop-sweep" }),
    intervalMs: settings.intervalMs,
    signal,
  });
}

export async function stopSweepLoop(at: {
  api: Pick<ResourcesApi, "verifyStops">;
  log: Logger;
  intervalMs: number;
  signal: AbortSignal;
}): Promise<void> {
  try {
    while (!at.signal.aborted) {
      at.log.info("permit stop sweep starting");
      try {
        const result = await at.api.verifyStops(at.signal);
        at.log.info({ result }, "permit stop sweep finished");
      } catch (error) {
        at.log.warn({ err: error }, "permit stop sweep failed; permits remain held");
      }
      await setTimeout(at.intervalMs, undefined, { signal: at.signal });
    }
  } catch (error) {
    ignoreAbort(error);
  }
}
