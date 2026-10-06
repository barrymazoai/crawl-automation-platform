import { z } from "zod";

/** Resource identities are stable; mini-ego-space-1 intentionally owns Ego space 2. */
export const BROWSER_RESOURCE_SPACES = {
  "mini-ego-space-1": 2,
  "server2-ego-space-6": 6,
  // DTC product pool on Server 二 (owner 2026-10-06); Ego assigned these space numbers.
  "server2-ego-space-14": 14,
  "server2-ego-space-15": 15,
  "server2-ego-space-16": 16,
} as const;
export const BrowserResourceIdSchema = z.enum([
  "mini-ego-space-1",
  "server2-ego-space-6",
  "server2-ego-space-14",
  "server2-ego-space-15",
  "server2-ego-space-16",
]);
export type BrowserResourceId = z.infer<typeof BrowserResourceIdSchema>;
export const LEGACY_BROWSER_QUEUE = "v3.browser.wholefoods.v1";

export function browserTaskQueue(resourceId: BrowserResourceId): string {
  return `v3.browser.${resourceId}`;
}

export function browserResourceOfQueue(queue: string): BrowserResourceId | undefined {
  return BrowserResourceIdSchema.options.find(
    (resourceId) => browserTaskQueue(resourceId) === queue,
  );
}

export function browserResources(resources: readonly string[]): BrowserResourceId[] {
  return resources.filter(
    (resourceId): resourceId is BrowserResourceId =>
      BrowserResourceIdSchema.safeParse(resourceId).success,
  );
}
