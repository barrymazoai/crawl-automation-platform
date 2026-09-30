import { errorCodeOf } from "@crawl-automation/platform";
import { ignoreAbort } from "@crawl-automation/platform";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "@crawl-automation/platform";
import type { ResourceService } from "../resources/resource-service.js";
import type { RunService } from "../runs/run-service.js";

export interface CleanupDeps {
  resources: Pick<ResourceService, "releaseStopped">;
  runs: Pick<RunService, "settleStopped">;
  log: Logger;
  intervalMs: number;
}

/**
 * Keeps ended work from holding anything: every sweep releases permits whose owner provably stopped, then
 * settles runs that ended without a clean completion. Nothing is released without stop evidence.
 */
export class CleanupService {
  constructor(private readonly deps: CleanupDeps) {}

  async sweep(): Promise<{ permitsReleased: number; runsSettled: number }> {
    const permits = await this.deps.resources.releaseStopped();
    const runs = await this.deps.runs.settleStopped();
    return { permitsReleased: permits.released.length, runsSettled: runs.length };
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.sweep().catch((error: unknown) => {
        this.deps.log.error({ err: error, code: errorCodeOf(error) }, "cleanup sweep failed");
      });
      await delay(this.deps.intervalMs, undefined, { signal }).catch(ignoreAbort);
    }
  }
}
