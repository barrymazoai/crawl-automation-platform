import { z } from "zod";

/** Resource identities are stable; mini-ego-space-1 intentionally owns Ego space 2. */
export const BROWSER_RESOURCE_SPACES = {
  "mini-ego-space-1": 2,
  "server2-ego-space-6": 6,
} as const;
export const BrowserResourceIdSchema = z.enum(["mini-ego-space-1", "server2-ego-space-6"]);
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
