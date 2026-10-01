import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  provePermitExecutionStopped,
  recordPermitExecution,
} from "../execution/permit-execution.js";
import { closeAndVerifyTarget } from "./ego-cleanup.js";
import { egoErrors } from "./ego-errors.js";
import { executeEgoScript, type EgoRoundResult } from "./ego-output.js";
import type { EgoSettings } from "./ego-settings.js";

export { EgoFailureSchema, type EgoRoundFailure } from "./ego-output.js";
type Execution = Awaited<ReturnType<typeof executeEgoScript>>;

/** Runs one Ego round and proves its exact task pages ended before its permit can settle. */
export class EgoRunner {
  private readonly host = hostname();

  constructor(private readonly settings: EgoSettings) {}

  async run(script: string, signal: AbortSignal): Promise<EgoRoundResult> {
    const round = {
      kind: "browser-round" as const,
      executionId: randomUUID(),
      taskSpaceId: this.settings.taskSpaceId,
      metadata: { host: this.host },
    };
    await recordPermitExecution(round);
    const opened = new Set<string>();
    const execution = await executeEgoScript(this.settings, {
      script,
      signal,
      opened: async (targetId) => {
        opened.add(targetId);
        await recordPermitExecution(this.identity(targetId));
      },
    });
    const result = await this.finish(execution, opened);
    await provePermitExecutionStopped(round, {
      kind: "browser-round-ended",
      targets: [...opened],
      observedAt: new Date().toISOString(),
    });
    return result;
  }

  private async finish(execution: Execution, opened: Set<string>): Promise<EgoRoundResult> {
    const { messages, answer, failure } = execution;
    if (messages.some((message) => message.kind === "stop")) {
      throw egoErrors.create("BROWSER.USER_CONTROL", { details: { opened: [...opened] } });
    }
    const result = messages.find((message): message is EgoRoundResult => message.kind === "result");
    if (result && !opened.has(result.targetId)) {
      opened.add(result.targetId);
      await recordPermitExecution(this.identity(result.targetId));
    }
    try {
      await this.stopTargets(opened, result);
    } catch (error) {
      throw egoErrors.create("BROWSER.PAGE_CLEANUP_PENDING", {
        cause: error,
        details: {
          opened: [...opened],
          targetId: result?.targetId,
          failure: result?.failure,
          cleanupFailure: result?.cleanupFailure,
          interrupted: { cancelled: answer.isCanceled, timedOut: answer.timedOut },
        },
      });
    }
    if (failure) {
      throw failure;
    }
    if (!result) {
      throw roundFailure(answer);
    }
    return { ...result, closed: true };
  }

  private async stopTargets(opened: Set<string>, result: EgoRoundResult | undefined) {
    for (const targetId of opened) {
      const proof =
        result?.targetId === targetId && result.closed
          ? {
              kind: "browser-target-absent",
              targetId,
              taskSpaceId: this.settings.taskSpaceId,
              observedAt: new Date().toISOString(),
            }
          : await closeAndVerifyTarget(this.settings, targetId);
      await provePermitExecutionStopped(this.identity(targetId), proof);
    }
  }

  private identity(targetId: string) {
    return {
      kind: "browser" as const,
      executionId: targetId,
      taskSpaceId: this.settings.taskSpaceId,
      metadata: { host: this.host },
    };
  }
}

interface ExecaAnswer {
  isCanceled: boolean;
  timedOut: boolean;
  isMaxBuffer: boolean;
  exitCode?: number | undefined;
}

/** Cleanup cannot turn an interrupted business round into a successful result. */
function roundFailure(answer: ExecaAnswer) {
  const details = { exitCode: answer.exitCode ?? null, executionUnknown: true };
  if (answer.isCanceled) {
    return egoErrors.create("BROWSER.CANCELLED", { details });
  }
  if (answer.timedOut) {
    return egoErrors.create("BROWSER.TIMEOUT", { details });
  }
  if (answer.isMaxBuffer) {
    return egoErrors.create("BROWSER.PAGE_LIMIT", { details });
  }
  return egoErrors.create("BROWSER.UNAVAILABLE", { details });
}
