import { egoErrors } from "./ego-errors.js";
import { executeEgoScript } from "./ego-output.js";
import { EGO_MARKER } from "./ego-script.js";
import { EgoSettingsSchema, type EgoSettings } from "./ego-settings.js";

import { EGO_OWNERSHIP } from "./ego-ownership.js";

export function egoHealthScript(taskSpaceId: number): string {
  return `const params = ${JSON.stringify({ taskSpaceId })};
const emit = value => console.log(${JSON.stringify(EGO_MARKER)} + JSON.stringify(value));
${EGO_OWNERSHIP}
try {
  await requireAgent();
  const task = await taskSpace(params.taskSpaceId);
  const tabs = await task.tabs();
  await requireAgent();
  emit({ kind: "health", code: null, targets: tabs.map(tab => tab.targetId) });
} catch (error) {
  emit({ kind: "health", code: error?.code ?? "BROWSER.UNAVAILABLE", targets: [] });
}`;
}

export interface EgoHealth {
  healthy: boolean;
  code: string | null;
  targets: string[];
}

/** Read-only, bounded, local CLI probe. Never creates, claims or takes over a space. */
export async function probeEgo(settings: EgoSettings, signal: AbortSignal): Promise<EgoHealth> {
  const execution = await executeEgoScript(settings, {
    script: egoHealthScript(settings.taskSpaceId),
    signal,
    timeoutMs: EgoSettingsSchema.parse(settings).probeTimeoutMs,
  });
  const health = execution.messages.find((message) => message.kind === "health");
  if (execution.answer.failed || execution.failure || !health) {
    return {
      healthy: false,
      code: execution.answer.timedOut ? "BROWSER.TIMEOUT" : "BROWSER.UNAVAILABLE",
      targets: [],
    };
  }
  return {
    healthy: health.code === null,
    code: normalizeHealthCode(health.code),
    targets: health.targets,
  };
}

export async function requireEgo(settings: EgoSettings, signal: AbortSignal): Promise<EgoHealth> {
  signal.throwIfAborted();
  const health = await probeEgo(settings, signal);
  signal.throwIfAborted();
  if (!health.healthy) {
    const code = normalizeHealthCode(health.code) ?? "BROWSER.UNAVAILABLE";
    throw egoErrors.create(code, { details: { reason: health.code } });
  }
  return health;
}

function normalizeHealthCode(code: string | null) {
  if (
    code === null ||
    code === "BROWSER.USER_CONTROL" ||
    code === "BROWSER.SPACE_MISSING" ||
    code === "BROWSER.TIMEOUT"
  ) {
    return code;
  }
  return "BROWSER.UNAVAILABLE" as const;
}
