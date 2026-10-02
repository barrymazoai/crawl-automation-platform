import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  provePermitExecutionStopped,
  recordPermitExecution,
} from "../execution/permit-execution.js";
import { egoErrors } from "./ego-errors.js";
import { requireEgo } from "./ego-health.js";
import { executeEgoScript, type EgoRoundResult } from "./ego-output.js";
import type { EgoSettings } from "./ego-settings.js";
import { stopEgoRound, type EgoStoppedRound } from "./ego-stop.js";

export { EgoFailureSchema, type EgoRoundFailure } from "./ego-output.js";
type Execution = Awaited<ReturnType<typeof executeEgoScript>>;

/** CLI exit and page absence are separate R59 receipts; neither substitutes for the other. */
export class EgoRunner {
  private readonly host = hostname();
  constructor(private readonly settings: EgoSettings) {}

  async run(script: string, signal: AbortSignal): Promise<EgoRoundResult> {
    const health = await requireEgo(this.settings, signal);
    const round = {
      kind: "browser-round" as const,
      executionId: randomUUID(),
      taskSpaceId: this.settings.taskSpaceId,
      metadata: { host: this.host, protocol: "ego-single-page/1", baseline: health.targets },
    };
    const cli = { ...round, kind: "browser-cli" as const, executionId: `${round.executionId}/cli` };
    await recordPermitExecution(round);
    await recordPermitExecution(cli);
    const targets: EgoStoppedRound["targets"] = [];
    const execution = await executeEgoScript(this.settings, {
      script,
      signal,
      opened: async (targetId) => {
        const identity = this.identity(targetId, round.executionId);
        targets.push(identity);
        await recordPermitExecution(identity);
      },
    });
    // Execa resolves only after child closure, including SIGKILL escalation on timeout/cancellation.
    await provePermitExecutionStopped(cli, {
      kind: "browser-cli-exited",
      pid: execution.pid,
      observedAt: new Date().toISOString(),
    });
    return this.finish(execution, { round, targets });
  }

  private async finish(execution: Execution, work: EgoStoppedRound): Promise<EgoRoundResult> {
    const { messages, answer } = execution;
    if (messages.some((message) => message.kind === "stop")) {
      throw egoErrors.create("BROWSER.USER_CONTROL", {
        details: { opened: work.targets.map((target) => target.executionId) },
      });
    }
    const result = messages.find((message): message is EgoRoundResult => message.kind === "result");
    if (result && !work.targets.some((target) => target.executionId === result.targetId)) {
      const identity = this.identity(result.targetId, work.round.executionId);
      await recordPermitExecution(identity);
      work.targets.push(identity);
    }
    try {
      await stopEgoRound(this.settings, {
        ...work,
        closedTarget: result?.closed ? result.targetId : undefined,
      });
    } catch (error) {
      throw egoErrors.create("BROWSER.PAGE_CLEANUP_PENDING", {
        cause: error,
        details: {
          targetId: result?.targetId,
          opened: work.targets.map((target) => target.executionId),
          failure: result?.failure,
          interrupted: roundFailure(answer).code,
          interruptedDetails: roundFailure(answer).details,
        },
      });
    }
    return completedResult(execution, result);
  }

  private identity(targetId: string, roundId: string) {
    return {
      kind: "browser" as const,
      executionId: targetId,
      taskSpaceId: this.settings.taskSpaceId,
      metadata: { host: this.host, roundId },
    };
  }
}

/** Interrupted browser operations are infrastructure failures, never page/content verdicts. */
function roundFailure(answer: Execution["answer"]) {
  // The CLI's own error text is the only clue to why a round could not run; keep its tail.
  const details = {
    exitCode: answer.exitCode ?? null,
    executionUnknown: true,
    stderr: String(answer.stderr ?? "").slice(-2000),
  };
  if (answer.isCanceled) {
    return egoErrors.create("BROWSER.CANCELLED", { details });
  }
  if (answer.timedOut) {
    return egoErrors.create("BROWSER.TIMEOUT", { details });
  }
  if (answer.isMaxBuffer) {
    return egoErrors.create("BROWSER.PROTOCOL", { details });
  }
  return egoErrors.create("BROWSER.UNAVAILABLE", { details });
}

function completedResult(execution: Execution, result: EgoRoundResult | undefined): EgoRoundResult {
  if (execution.failure) {
    throw execution.failure;
  }
  if (execution.answer.failed || !result) {
    throw roundFailure(execution.answer);
  }
  return { ...result, closed: true };
}
