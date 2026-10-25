import { DENY_LOCATION } from "./ego-script.js";
import { DENY_NOTIFICATIONS } from "./deny-notifications.js";
import { EGO_OWNERSHIP } from "./ego-ownership.js";
import { EGO_AGENT_NAVIGATION } from "./ego-agent-navigation.js";

const PRELOAD_SOURCE = `(() => {
    const marker = Symbol.for("crawler.dtc.permissions/2");
    if (globalThis[marker]) return;
    ${DENY_LOCATION}
    ${DENY_NOTIFICATIONS}
    globalThis[marker] = true;
  })();`;

/**
 * CDP preload registration belongs to one CLI session, so prepare in the call that navigates. The module also exports
 * the task's evidence directory: a model that copied the 64-character task hash by hand dropped a character and saved
 * every page into a sibling folder the host never reads (bloodsugarfriendly.com, 2026-10-20).
 */
export function agentPagePreparationModule(
  input: { taskSpaceId: number; label: string; targetId: string },
  paths: { outDir?: string; workDir?: string; nativeOriginalsModuleUrl?: string } = {},
): string {
  const exports = paths.outDir ? `export const outDir = ${JSON.stringify(paths.outDir)};\n` : "";
  return `import { appendFile } from "node:fs/promises";
${movedRecording(paths)}
${exports}const params = ${JSON.stringify(input)};
export async function prepareBrowserRound({ taskSpace, listTaskSpaces }) {
  ${EGO_OWNERSHIP}
  await requireAgent();
  const task = await taskSpace(params.taskSpaceId);
  const target = (await task.tabs()).find(tab => tab.label === params.label);
  if (target?.targetId !== params.targetId || target.openedBy !== "agent") throw Error("BROWSER.TARGET_MISMATCH");
  const page = task.page(params.label);
  await requireAgent();
  await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: ${JSON.stringify(PRELOAD_SOURCE)}, runImmediately: true });
  const state = await page.evaluate(() => ({
    installed: globalThis[Symbol.for("crawler.dtc.permissions/2")] === true,
    url: location.href,
    notification: typeof Notification === "undefined" ? "unavailable" : Notification.permission,
  }));
  if (!state.installed || !["denied", "unavailable"].includes(state.notification)) throw Error("BROWSER.PAGE_PREPARATION_FAILED");
  await requireAgent();
  await appendFile(new URL("browser-preparation.jsonl", import.meta.url), JSON.stringify({
    policy: "deny-each-ego-call/2", taskSpaceId: params.taskSpaceId, label: params.label,
    targetId: target.targetId, observedAt: new Date().toISOString(), ...state,
  }) + "\\n");
  ${EGO_AGENT_NAVIGATION}
  return { task, page, navigate };
}
`;
}

/** Product captures record a redirected product; other agent pages (brand research) navigate as before. */
function movedRecording(paths: { workDir?: string; nativeOriginalsModuleUrl?: string }): string {
  if (!paths.workDir || !paths.nativeOriginalsModuleUrl) {
    return "const isRecordedProductMove = () => false;\nconst retainMovedOriginal = async () => {};\nconst workDir = null;";
  }
  return `import { isRecordedProductMove, retainMovedOriginal } from ${JSON.stringify(paths.nativeOriginalsModuleUrl)};
const workDir = ${JSON.stringify(paths.workDir)};`;
}
