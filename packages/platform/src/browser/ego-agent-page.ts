import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  recordPermitExecution,
  provePermitExecutionStopped,
} from "../execution/permit-execution.js";
import { executeEgoScript } from "./ego-output.js";
import { requireEgo } from "./ego-health.js";
import { EGO_MARKER } from "./ego-script.js";
import { EGO_OWNERSHIP } from "./ego-ownership.js";
import { agentPagePreparationModule } from "./ego-agent-preparation.js";
import { egoErrors } from "./ego-errors.js";
import { stopEgoRound, type EgoStoppedRound } from "./ego-stop.js";
import type { EgoSettings } from "./ego-settings.js";

/** One host-owned page across a Codex capture's native Ego calls. */
export class EgoAgentPage {
  private constructor(
    private readonly settings: EgoSettings,
    private readonly page: { targetId: string; label: string },
    private readonly work: EgoStoppedRound,
  ) {}

  get targetId() {
    return this.page.targetId;
  }
  get label() {
    return this.page.label;
  }

  preparationModule() {
    return agentPagePreparationModule({ taskSpaceId: this.settings.taskSpaceId, ...this.page });
  }

  static async open(settings: EgoSettings, signal: AbortSignal): Promise<EgoAgentPage> {
    const health = await requireEgo(settings, signal);
    const work: EgoStoppedRound = {
      round: {
        kind: "browser-round",
        executionId: randomUUID(),
        taskSpaceId: settings.taskSpaceId,
        metadata: {
          host: hostname(),
          protocol: "ego-native-capture/1",
          baseline: health.targets,
          notificationPolicy: "deny-each-ego-call/2",
        },
      },
      targets: [],
    };
    await recordPermitExecution(work.round);
    try {
      return await openPage(settings, work, signal);
    } catch (error) {
      await stopEgoRound(settings, work);
      throw error;
    }
  }

  static owned(
    settings: EgoSettings,
    value: { targetId: string; label: string },
    work: EgoStoppedRound,
  ) {
    return new EgoAgentPage(settings, value, work);
  }

  /** Call only once every Codex command has ended; user ownership remains a hard stop. */
  async close(): Promise<void> {
    await stopEgoRound(this.settings, this.work);
  }
}

async function openPage(settings: EgoSettings, work: EgoStoppedRound, signal: AbortSignal) {
  const cli = {
    kind: "browser-cli" as const,
    executionId: `${work.round.executionId}/cli`,
    taskSpaceId: settings.taskSpaceId,
    metadata: { host: hostname() },
  };
  await recordPermitExecution(cli);
  const execution = await executeEgoScript(settings, {
    script: openScript(settings.taskSpaceId),
    signal,
    opened: async (targetId) => {
      const identity = {
        kind: "browser" as const,
        executionId: targetId,
        taskSpaceId: settings.taskSpaceId,
        metadata: { host: hostname(), roundId: work.round.executionId },
      };
      work.targets.push(identity);
      await recordPermitExecution(identity);
    },
  });
  await provePermitExecutionStopped(cli, {
    kind: "browser-cli-exited",
    pid: execution.pid,
    observedAt: new Date().toISOString(),
  });
  const result = execution.messages.find((message) => message.kind === "result");
  if (
    execution.answer.failed ||
    execution.failure ||
    !result ||
    result.failure ||
    typeof result.value !== "string"
  ) {
    throw egoErrors.create("BROWSER.UNAVAILABLE", { cause: execution.failure ?? result?.failure });
  }
  return EgoAgentPage.owned(settings, { targetId: result.targetId, label: result.value }, work);
}

function openScript(taskSpaceId: number) {
  return `const params = ${JSON.stringify({ taskSpaceId })};
const emit = value => console.log(${JSON.stringify(EGO_MARKER)} + JSON.stringify(value));
${EGO_OWNERSHIP}
await requireAgent();
const task = await taskSpace(params.taskSpaceId);
const page = await task.newPage();
emit({ kind: "opened", targetId: page.targetId });
await requireAgent();
emit({ kind: "result", targetId: page.targetId, closed: false, failure: null, value: page.label });`;
}
