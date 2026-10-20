import { egoErrors } from "./ego-errors.js";
import { executeEgoScript } from "./ego-output.js";
import { EGO_MARKER } from "./ego-script.js";
import type { EgoSettings } from "./ego-settings.js";

function spaceScript(name: string): string {
  return `const params = ${JSON.stringify({ name })};
const emit = value => console.log(${JSON.stringify(EGO_MARKER)} + JSON.stringify(value));
try {
  const task = await taskSpace(params.name);
  emit({ kind: "space", spaceId: task.spaceId, ownership: task.ownership, code: null });
} catch (error) {
  emit({ kind: "space", spaceId: null, ownership: null, code: String(error?.code ?? error?.message ?? error).slice(0, 200) });
}`;
}

/**
 * Owner 2026-10-20: the crawler's task space is found by its name, never by a remembered number. Ego forgets its
 * spaces when it restarts and numbers them anew, so `taskSpace(name)` resumes the crawler's own space with that name or
 * creates exactly one. A name held by the user's space is a hard stop; the crawler never claims it.
 */
export async function resolveEgoSpace(
  settings: EgoSettings,
  name: string,
  signal: AbortSignal,
): Promise<number> {
  const execution = await executeEgoScript(settings, { script: spaceScript(name), signal });
  const space = execution.messages.find((message) => message.kind === "space");
  if (execution.answer.failed || execution.failure || !space) {
    throw egoErrors.create("BROWSER.UNAVAILABLE", {
      cause: execution.failure,
      details: { name },
    });
  }
  if (space.ownership !== "agent" || space.spaceId === null) {
    const code =
      space.code?.includes("NAME_IN_USE") || space.ownership
        ? "BROWSER.USER_CONTROL"
        : "BROWSER.UNAVAILABLE";
    throw egoErrors.create(code, {
      details: { name, ownership: space.ownership, reason: space.code },
    });
  }
  return space.spaceId;
}
