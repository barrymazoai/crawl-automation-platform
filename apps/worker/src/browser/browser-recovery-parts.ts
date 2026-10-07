import { hostname } from "node:os";
import { setTimeout } from "node:timers/promises";
import {
  PostgresPermitExecutions,
  PostgresResourceStore,
  TemporalWorkflowTree,
} from "@crawl-automation/adapters";
import { BrowserRecovery, ResourceService } from "@crawl-automation/app";
import {
  connectTemporal,
  egoCliAbsent,
  EgoSettingsSchema,
  ignoreAbort,
  stopEgoRound,
} from "@crawl-automation/platform";
import type { CoreParts } from "../core-parts.js";

/** Manual-start worker lifetime; survives Ego outages without restarting or replaying business work. */
export async function runBrowserRecovery(parts: CoreParts, signal: AbortSignal): Promise<void> {
  const settings = EgoSettingsSchema.parse(parts.config.browser?.ego);
  const temporal = await connectTemporal(parts.config.temporal);
  const log = parts.log.child({ service: "browser-cleanup" });
  const resources = new ResourceService({
    resources: new PostgresResourceStore(parts.database),
    workflows: new TemporalWorkflowTree(temporal.client),
    log,
  });
  const recovery = new BrowserRecovery({
    ledger: new PostgresPermitExecutions(parts.database),
    stop: (work) => stopEgoRound(settings, work),
    release: (permitId) => resources.release(permitId),
    cliAbsent: (recordedAt) => egoCliAbsent(settings, recordedAt),
    log,
  });
  try {
    while (!signal.aborted) {
      try {
        await recovery.tick(hostname(), settings.taskSpaceId);
      } catch (error) {
        log.warn({ err: error }, "browser recovery unavailable");
      }
      await setTimeout(settings.recoveryIntervalMs, undefined, { signal });
    }
  } catch (error) {
    ignoreAbort(error);
  } finally {
    await temporal.close();
  }
}
