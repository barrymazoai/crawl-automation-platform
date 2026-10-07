import {
  errorCodeOf,
  provePermitExecutionStopped,
  withPermitExecution,
  type Logger,
  type PermitExecutionIdentity,
  type PermitOwner,
} from "@crawl-automation/platform";
import type { PermitActivityLedger } from "../stops/permit-activity.js";
import type { EgoStoppedRound } from "@crawl-automation/platform";

export interface BrowserRecoveryEntry {
  owner: PermitOwner;
  executions: { identity: PermitExecutionIdentity; stopped: boolean; recordedAt?: string }[];
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
      /** Host proof that a CLI recorded at this time has exited, when its own receipt was lost. */
      cliAbsent?(recordedAt: Date): Promise<Record<string, unknown> | null>;
      /** Host proof that a Codex process group recorded here has exited, when its own receipt was lost. */
      codexAbsent?(identity: PermitExecutionIdentity): Promise<Record<string, unknown> | null>;
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

  /** A worker shutdown mid-round loses the CLI exit receipt; the host process list can still prove it. */
  private async cliGone(cli: BrowserRecoveryEntry["executions"][number]): Promise<boolean> {
    if (!this.deps.cliAbsent || !cli.recordedAt) {
      return false;
    }
    const proof = await this.deps.cliAbsent(new Date(cli.recordedAt));
    if (!proof) {
      return false;
    }
    await provePermitExecutionStopped(cli.identity, proof);
    return true;
  }

  /** Codex ran on this host and its exit receipt was lost: the host process table decides. */
  private async codexGone(
    entry: BrowserRecoveryEntry,
    scope: { host: string; taskSpaceId: number },
  ): Promise<void> {
    for (const execution of entry.executions) {
      const identity = execution.identity;
      if (execution.stopped || identity.kind !== "codex" || identity.host !== scope.host) {
        continue;
      }
      const proof = await this.deps.codexAbsent?.(identity);
      if (proof) {
        await provePermitExecutionStopped(identity, proof);
        execution.stopped = true;
      }
    }
  }

  async recover(
    entry: BrowserRecoveryEntry,
    scope: { host: string; taskSpaceId: number },
  ): Promise<void> {
    await this.codexGone(entry, scope);
    for (const execution of entry.executions) {
      const round = execution.identity;
      if (!localRound(execution, scope) || nativeAgentRunning(round, entry)) {
        continue;
      }
      const cli = entry.executions.find(
        (item) =>
          item.identity.executionId === `${round.executionId}/cli` &&
          item.identity.metadata?.host === scope.host &&
          "taskSpaceId" in item.identity &&
          item.identity.taskSpaceId === scope.taskSpaceId,
      );
      if (cli?.identity.kind !== "browser-cli" || !(cli.stopped || (await this.cliGone(cli)))) {
        continue;
      }
      const targets = entry.executions.filter(
        (item) =>
          item.identity.kind === "browser" &&
          item.identity.metadata?.roundId === round.executionId &&
          item.identity.metadata.host === scope.host &&
          item.identity.taskSpaceId === scope.taskSpaceId,
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

function nativeAgentRunning(round: PermitExecutionIdentity, entry: BrowserRecoveryEntry): boolean {
  return (
    round.metadata?.protocol === "ego-native-capture/1" &&
    entry.executions.some((item) => item.identity.kind === "codex" && !item.stopped)
  );
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
    ["ego-single-page/1", "ego-native-capture/1"].includes(String(identity.metadata?.protocol))
  );
}
