import { activityIdentity } from "./activity-identity.js";
import type { Logger } from "@crawl-automation/platform";
const policies = new WeakMap<Logger, () => Promise<void>>();
export function registerActivityPolicies(log: Logger, refresh: () => Promise<void>): void {
  policies.set(log, refresh);
}
export function refreshActivityPolicies(log: Logger, raw: unknown): Promise<void> | undefined {
  if (activityIdentity(raw).channel === "dtc") {
    return policies.get(log)?.();
  }
  return undefined;
}
