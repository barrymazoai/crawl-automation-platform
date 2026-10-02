import {
  provePermitExecutionStopped,
  type PermitExecutionIdentity,
} from "../execution/permit-execution.js";
import { closeAndVerifyTarget } from "./ego-cleanup.js";
import { egoErrors } from "./ego-errors.js";
import { requireEgo } from "./ego-health.js";
import type { EgoSettings } from "./ego-settings.js";

export interface EgoStoppedRound {
  round: PermitExecutionIdentity;
  targets: PermitExecutionIdentity[];
  stoppedTargets?: string[];
  /** A final result proves the single-page script reached its end. */
  closedTarget?: string | undefined;
}

/** Shared by the original activity and durable recovery; emits only the existing R59 receipts. */
export async function stopEgoRound(settings: EgoSettings, work: EgoStoppedRound): Promise<void> {
  for (const identity of work.targets) {
    if (work.stoppedTargets?.includes(identity.executionId)) {
      continue;
    }
    const proof =
      identity.executionId === work.closedTarget
        ? {
            kind: "browser-target-absent",
            targetId: identity.executionId,
            observedAt: new Date().toISOString(),
          }
        : await closeAndVerifyTarget(settings, identity.executionId);
    await provePermitExecutionStopped(identity, proof);
  }
  // With no reported page, the baseline decides after a short settle: the CLI has exited, so any page it
  // opened is a new tab here; no new tab means nothing is left to close. A late unknown tab stays pending.
  if (work.targets.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, settings.noPageSettleMs ?? 3_000));
  }
  const current = await requireEgo(settings, AbortSignal.timeout(10_000));
  const baseline = work.round.metadata?.baseline;
  // Unknown new tabs (including popups) are not ours to close by inference, even after a result.
  if (!Array.isArray(baseline) || current.targets.some((target) => !baseline.includes(target))) {
    throw egoErrors.create("BROWSER.PAGE_CLEANUP_PENDING", {
      details: { round: work.round, targets: current.targets },
    });
  }
  await provePermitExecutionStopped(work.round, {
    kind: "browser-round-ended",
    targets: work.targets.map((target) => target.executionId),
    observedAt: new Date().toISOString(),
  });
}
