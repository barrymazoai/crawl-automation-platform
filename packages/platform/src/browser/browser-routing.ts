import { z } from "zod";

/**
 * Resource identities are stable; each names its Ego task space (owner 2026-10-20: match spaces by name). Ego forgets
 * its spaces on restart and numbers new ones upward, so the numbers in these ids are history, not the Ego numbers.
 */
export const BROWSER_RESOURCE_SPACES = {
  "mini-ego-space-1": "crawler-browser-worker",
  "server2-ego-space-6": "crawler-browser-worker",
  // DTC product pool on Server 二 (owner 2026-10-06).
  "server2-ego-space-14": "crawler-dtc-product-1",
  "server2-ego-space-15": "crawler-dtc-product-2",
  "server2-ego-space-16": "crawler-dtc-product-3",
  // Brand enrichment only (owner 2026-10-09): family check and research.
  "server2-ego-space-17": "crawler-brand-website",
} as const;
export const BrowserResourceIdSchema = z.enum([
  "mini-ego-space-1",
  "server2-ego-space-6",
  "server2-ego-space-14",
  "server2-ego-space-15",
  "server2-ego-space-16",
  "server2-ego-space-17",
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
