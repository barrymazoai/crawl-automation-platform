import { DENY_LOCATION } from "./ego-script.js";
import { DENY_NOTIFICATIONS } from "./deny-notifications.js";
import { EGO_OWNERSHIP } from "./ego-ownership.js";
import { EGO_AGENT_NAVIGATION } from "./ego-agent-navigation.js";

/** CDP preload registration belongs to one CLI session, so prepare in the call that navigates. */
export function agentPagePreparationModule(input: {
  taskSpaceId: number;
  label: string;
  targetId: string;
}): string {
  const source = `(() => {
    const marker = Symbol.for("crawler.dtc.permissions/2");
    if (globalThis[marker]) return;
    ${DENY_LOCATION}
    ${DENY_NOTIFICATIONS}
    globalThis[marker] = true;
  })();`;
  return `import { appendFile } from "node:fs/promises";
const params = ${JSON.stringify(input)};
export async function prepareBrowserRound({ taskSpace, listTaskSpaces }) {
  ${EGO_OWNERSHIP}
  await requireAgent();
  const task = await taskSpace(params.taskSpaceId);
  const target = (await task.tabs()).find(tab => tab.label === params.label);
  if (target?.targetId !== params.targetId || target.openedBy !== "agent") throw Error("BROWSER.TARGET_MISMATCH");
  const page = task.page(params.label);
  await requireAgent();
  await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: ${JSON.stringify(source)}, runImmediately: true });
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
