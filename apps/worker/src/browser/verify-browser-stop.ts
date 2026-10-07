import { hostname } from "node:os";
import {
  PostgresPermitExecutions,
  PostgresResourceStore,
  PostgresStopVerification,
  TemporalWorkflowTree,
} from "@crawl-automation/adapters";
import { assertBrowserPermit, BrowserRecovery, requireClosedOwner } from "@crawl-automation/app";
import {
  connectTemporal,
  egoCliAbsent,
  stopEgoRound,
  withPermitExecution,
  type PermitExecutionIdentity,
} from "@crawl-automation/platform";
import { resourceGateErrors } from "@crawl-automation/platform/errors/resource-gate";
import { BrowserStopInputSchema } from "@crawl-automation/workflows";
import type { z } from "zod";
import type { CoreParts } from "../core-parts.js";

type Input = z.infer<typeof BrowserStopInputSchema>;

/** Even if a workflow times out, its still-running cleanup cannot race another close on this host. */
export async function verifyBrowserStop(parts: CoreParts, raw: unknown): Promise<void> {
  const input = BrowserStopInputSchema.parse(raw);
  const recovered = await new PostgresStopVerification(parts.database).exclusive(async () => {
    await verifyOnHost(parts, input);
    return true;
  }, `resources.verifyStop.browser.${input.resourceId}`);
  if (!recovered) {
    throw resourceGateErrors.create("RESOURCE.CLEANUP_UNVERIFIED", {
      details: { reason: "browser_verification_busy", owner: input.owner },
    });
  }
}

/** Check the original owner again on the executor host before touching any target. */
async function verifyOnHost(parts: CoreParts, input: Input): Promise<void> {
  const { owner, resourceId } = input;
  const settings = parts.config.browser;
  if (settings?.resourceId !== resourceId) {
    throw resourceGateErrors.create("RESOURCE.BROWSER_PERMIT_MISMATCH");
  }
  const resources = new PostgresResourceStore(parts.database);
  await assertBrowserPermit({ resources, owner, resourceId });
  const temporal = await connectTemporal(parts.config.temporal);
  try {
    await requireClosedOwner(new TemporalWorkflowTree(temporal.client), owner, new Date());
    const permit = await resources.findHeld(owner.permitId);
    const ledger = new PostgresPermitExecutions(parts.database);
    const recovery = new BrowserRecovery({
      ledger,
      stop: (work) => stopEgoRound(settings.ego, work),
      release: async () => undefined,
      cliAbsent: (recordedAt) => egoCliAbsent(settings.ego, recordedAt),
      log: parts.log,
    });
    const executions = (permit?.cleanup?.executions ?? []).map((entry) => ({
      identity: entry.identity as PermitExecutionIdentity,
      stopped: entry.stoppedAt !== null && entry.proof !== null,
      ...(entry.recordedAt ? { recordedAt: entry.recordedAt } : {}),
    }));
    await withPermitExecution({ owner, ledger }, () =>
      recovery.recover(
        { owner, executions },
        { host: hostname(), taskSpaceId: settings.ego.taskSpaceId },
      ),
    );
  } finally {
    await temporal.close();
  }
}
