import { egoErrors } from "./ego-errors.js";
import { executeEgoScript } from "./ego-output.js";
import { closeTargetScript, EGO_MARKER } from "./ego-script.js";
import type { EgoSettings } from "./ego-settings.js";

/** Recovery has its own bounded lifetime; a cancelled business activity cannot cancel its cleanup. */
export async function closeAndVerifyTarget(settings: EgoSettings, targetId: string) {
  const cleanupSettings = { ...settings, roundTimeoutMs: Math.min(settings.roundTimeoutMs, 5_000) };
  const signal = AbortSignal.timeout(25_000);
  const params = { taskSpaceId: settings.taskSpaceId, targetId };
  let failure: unknown;
  try {
    const close = await executeEgoScript(cleanupSettings, {
      script: closeTargetScript(params),
      signal,
    });
    rejectUserControl(close.messages);
    failure = close.failure;
    // A close receipt can precede the tab inventory update; never repeat the close blindly.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const check = await executeEgoScript(cleanupSettings, {
        script: targetAbsenceScript(params),
        signal,
      });
      rejectUserControl(check.messages);
      failure = check.failure ?? failure;
      if (
        !check.failure &&
        check.messages.some(
          (message) => message.kind === "result" && message.targetId === targetId && message.closed,
        )
      ) {
        return { kind: "browser-target-absent", ...params, observedAt: new Date().toISOString() };
      }
    }
  } catch (error) {
    throw egoErrors.create("BROWSER.PAGE_CLEANUP_PENDING", { cause: error, details: params });
  }
  throw egoErrors.create("BROWSER.PAGE_CLEANUP_PENDING", { cause: failure, details: params });
}

function rejectUserControl(messages: { kind: string }[]) {
  if (messages.some((message) => message.kind === "stop")) {
    throw egoErrors.create("BROWSER.USER_CONTROL");
  }
}

/** Only enumerates this space; never takes control, opens a page, or repeats a close. */
export function targetAbsenceScript(params: { taskSpaceId: number; targetId: string }): string {
  return `const emit = (value) => console.log(${JSON.stringify(EGO_MARKER)} + JSON.stringify(value));
const params = ${JSON.stringify(params)};
const task = await taskSpace(params.taskSpaceId);
if (task.ownership === "user") {
  emit({ kind: "stop", reason: "user-control" });
} else {
  const closed = !(await task.tabs()).some((tab) => tab.targetId === params.targetId);
  emit({ kind: "result", targetId: params.targetId, closed, failure: null, value: null });
}`;
}
