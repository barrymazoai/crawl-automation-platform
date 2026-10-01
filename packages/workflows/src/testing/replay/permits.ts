import type { ResourceRequest } from "@crawl-automation/v3-contracts";
import { expect } from "vitest";

/** These test activities perform synchronous work; their exact held permit is the fake journal. */
export function stopProofActivities(held: Set<string>) {
  return {
    prepareResourceExecution: async ({ permitId }: ResourceRequest) => {
      expect(held.has(permitId)).toBe(true);
    },
    stopResourceExecution: async ({ permitId }: ResourceRequest) => {
      expect(held.has(permitId)).toBe(true);
      return { permitId, state: "stopped", attempts: 1 };
    },
  };
}

/** Known executed outcomes retain the original activity sequence, even on new runs. */
export function permitCommands(activity: string): string[] {
  return ["reserveResources", activity, "releaseResources"];
}
