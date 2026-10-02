import { KNOWN_RESOURCE_KINDS } from "@crawl-automation/channels-core";
import { PostgresResourceHealth } from "@crawl-automation/adapters";
import { probeEgo } from "@crawl-automation/platform";
import { ResourceRequestSchema } from "@crawl-automation/v3-contracts";
import type { CoreParts } from "../core-parts.js";
import type { WorkerConfig } from "../config.js";

/** Explicit browser targets and registered browser resources must never pass on pollers alone. */
export function isBrowserResource(config: WorkerConfig, resourceId: string): boolean {
  const queues = Object.values(config.processes ?? {})
    .flatMap((process) => process.roles)
    .filter((role) => role.role === "browser")
    .map((role) => role.taskQueue);
  const target = config.resourceHealth?.resources[resourceId];
  return (
    target?.taskQueues.some((queue) => queues.includes(queue)) === true ||
    config.resourceHealth?.resources[resourceId]?.browser === true ||
    { ...KNOWN_RESOURCE_KINDS, ...config.resourceKinds }[resourceId] === "browser"
  );
}

export async function browserHealthReason(
  parts: CoreParts,
  signal: AbortSignal,
): Promise<string | null> {
  const settings = parts.config.browser?.ego;
  if (!settings) {
    return "BROWSER.CONFIG_INVALID";
  }
  return (await probeEgo(settings, signal)).code;
}

/** Fresh pre-admission check. The normal gate receives waiting, so it schedules no business activity. */
export async function reserveWithBrowserHealth(context: {
  parts: CoreParts;
  raw: unknown;
  signal: AbortSignal;
  reserve(raw: unknown): Promise<unknown>;
}): Promise<unknown> {
  const { parts, raw, signal, reserve } = context;
  const request = ResourceRequestSchema.parse(raw);
  for (const need of request.needs) {
    if (!isBrowserResource(parts.config, need.resourceId)) {
      continue;
    }
    const target = parts.config.resourceHealth?.resources[need.resourceId];
    // Remote health belongs to its configured controller. Never probe a different machine's space.
    if (!target) {
      continue;
    }
    const reason = await browserHealthReason(parts, signal);
    if (reason) {
      const settings = parts.config.resourceHealth;
      if (!settings) {
        return { permitId: request.permitId, status: "waiting", reason };
      }
      const matched = await new PostgresResourceHealth(parts.database).write({
        resourceId: need.resourceId,
        controller: settings.controller,
        healthy: false,
        reason: `browser:${reason}`,
        ttlMs: settings.ttlMs,
      });
      // Admission still checks the immutable prior decision before the unhealthy row: a lost
      // grant response must not hide an already held permit behind a new waiting response.
      return matched > 0
        ? reserve(raw)
        : { permitId: request.permitId, status: "waiting", reason: `browser:${reason}` };
    }
  }
  return reserve(raw);
}
