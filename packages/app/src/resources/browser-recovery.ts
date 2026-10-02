import {
  errorCodeOf,
  withPermitExecution,
  type Logger,
  type PermitExecutionIdentity,
  type PermitOwner,
} from "@crawl-automation/platform";
import type { PermitActivityLedger } from "../stops/permit-activity.js";
import type { EgoStoppedRound } from "@crawl-automation/platform";

export interface BrowserRecoveryEntry {
  owner: PermitOwner;
  executions: { identity: PermitExecutionIdentity; stopped: boolean }[];
}

export interface BrowserRecoveryLedger extends PermitActivityLedger {
  pendingBrowser(host: string, taskSpaceId: number): Promise<BrowserRecoveryEntry[]>;
}

/** Only cleanup is repeated. Finished business activities and their original failures stay immutable. */
export class BrowserRecovery {
  constructor(
    private readonly deps: {
      ledger: BrowserRecoveryLedger;
      stop(work: EgoStoppedRound): Promise<void>;
      release(permitId: string): Promise<unknown>;
      log: Logger;
    },
  ) {}

  async tick(host: string, taskSpaceId: number): Promise<void> {
    for (const entry of await this.deps.ledger.pendingBrowser(host, taskSpaceId)) {
      try {
        await withPermitExecution({ owner: entry.owner, ledger: this.deps.ledger }, () =>
          this.recover(entry, { host, taskSpaceId }),
        );
        await this.deps.ledger.finish(entry.owner, null);
        // ResourceService additionally requires a terminal Temporal owner and all R59 receipts.
        await this.deps.release(entry.owner.permitId);
      } catch (error) {
        this.deps.log.warn(
          { permitId: entry.owner.permitId, code: errorCodeOf(error), err: error },
          "browser cleanup pending",
        );
      }
    }
  }

  private async recover(
    entry: BrowserRecoveryEntry,
    scope: { host: string; taskSpaceId: number },
  ): Promise<void> {
    for (const execution of entry.executions) {
      const round = execution.identity;
      if (!localRound(execution, scope)) {
        continue;
      }
      const cli = entry.executions.find(
        (item) => item.identity.executionId === `${round.executionId}/cli`,
      );
      if (!cli?.stopped || cli.identity.kind !== "browser-cli") {
        continue;
      }
      const targets = entry.executions.filter(
        (item) =>
          item.identity.kind === "browser" && item.identity.metadata?.roundId === round.executionId,
      );
      await this.deps.stop({
        round,
        targets: targets.map((item) => item.identity),
        stoppedTargets: targets
          .filter((item) => item.stopped)
          .map((item) => item.identity.executionId),
      });
    }
  }
}

function localRound(
  execution: BrowserRecoveryEntry["executions"][number],
  scope: { host: string; taskSpaceId: number },
): boolean {
  const identity = execution.identity;
  return (
    !execution.stopped &&
    identity.kind === "browser-round" &&
    identity.taskSpaceId === scope.taskSpaceId &&
    identity.metadata?.host === scope.host &&
    identity.metadata?.protocol === "ego-single-page/1"
  );
}
