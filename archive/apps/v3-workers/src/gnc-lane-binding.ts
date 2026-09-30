import { type FixedLanePool, type LaneGrant, LanePoolError } from "@crawl-automation/v3-acquisition";
import { GncAcquireInputSchema } from "@crawl-automation/v3-contracts";
import { GncBrowserConfigSchema } from "./gnc-config.js";

/** Runtime admission is BEFORE polling/dispatching a source session; never in OCR/Codex activities.
 * Only NEW task identities are accepted: callers cannot silently rebind an already-published task.
 */
export async function bindNewGncLaneTask(pool: FixedLanePool, grant: LaneGrant, raw: unknown,
  runtime: { laneId: string; browser: unknown; proxyUrl: string }) {
  await pool.assertHeld(grant);
  const browser = GncBrowserConfigSchema.safeParse(runtime.browser);
  const task = GncAcquireInputSchema.safeParse(raw);
  if (!browser.success || !task.success || runtime.laneId !== grant.laneId || browser.data.sessionId !== grant.sessionId ||
    task.data.capture.binding.sessionId !== grant.sessionId || task.data.capture.binding.egressId !== grant.route.egressId ||
    JSON.stringify(task.data.network) !== JSON.stringify(grant.route)) throw new LanePoolError("NETWORK.LANE_LEASE_INVALID");
  // The launcher owns this allowlisted endpoint; never take a proxy URL from a Workflow payload.
  let proxy: URL;
  try { proxy = new URL(runtime.proxyUrl); } catch { throw new LanePoolError("NETWORK.LANE_CONFIG"); }
  if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1" || !proxy.port || proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash)
    throw new LanePoolError("NETWORK.LANE_CONFIG");
  return {
    task: task.data, capture: { network: grant.route, browser: browser.data },
    files: { network: grant.route, proxyUrl: runtime.proxyUrl },
    // This private grant stays on the host. Temporal sees only the task's public route/session IDs.
    lease: grant,
  };
}
