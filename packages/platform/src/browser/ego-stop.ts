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
  // A CLI exit cannot rule out a late newPage RPC whose target was never reported.
  if (work.targets.length === 0) {
    throw egoErrors.create("BROWSER.PAGE_CLEANUP_PENDING", {
      details: { round: work.round, reason: "unreported-page" },
    });
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
