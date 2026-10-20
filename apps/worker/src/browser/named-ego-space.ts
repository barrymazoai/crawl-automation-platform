import { createLogger, resolveEgoSpace } from "@crawl-automation/platform";
import { BROWSER_RESOURCE_SPACES } from "@crawl-automation/platform/browser-routing";
import type { WorkerConfig } from "../config.js";
import type { SelectedProcess } from "../processes/select-process.js";

/**
 * Owner 2026-10-20: a browser process finds its Ego task space by the name its resource names, at startup. The
 * number in the config is only the last one seen: after an Ego restart the space is recreated under the same name,
 * one per name, instead of placeholder spaces counting up to an old number (Server 二, 2026-10-17).
 */
export async function withNamedEgoSpace(
  config: WorkerConfig,
  chosen: SelectedProcess,
): Promise<WorkerConfig> {
  const browser = config.browser;
  // The resources role probes the local space's health (Server 一), so it needs the same space as the browser role.
  const probesHealth = config.resourceHealth?.resources[browser?.resourceId ?? ""] !== undefined;
  if (
    !browser ||
    !chosen.roles.some(
      (role) => role.role === "browser" || (role.role === "resources" && probesHealth),
    )
  ) {
    return config;
  }
  const name = BROWSER_RESOURCE_SPACES[browser.resourceId];
  const taskSpaceId = await resolveEgoSpace(browser.ego, name, AbortSignal.timeout(60_000));
  if (taskSpaceId !== browser.ego.taskSpaceId) {
    createLogger({ name: "worker" }).info(
      { resourceId: browser.resourceId, name, configured: browser.ego.taskSpaceId, taskSpaceId },
      "Ego task space found by name",
    );
  }
  return { ...config, browser: { ...browser, ego: { ...browser.ego, taskSpaceId } } };
}
