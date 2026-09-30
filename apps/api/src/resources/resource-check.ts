import {
  assertCaptureGate,
  CHANNEL_IDS,
  KNOWN_RESOURCE_KINDS,
  resourceKindOf,
  type ChannelId,
  type ResourceKinds,
} from "@crawl-automation/channels-core";
import type { ResourceGate } from "@crawl-automation/v3-contracts";
import { channelRegistry } from "./channel-registry.js";

/** Checks every configured capture gate against its registered adapter before the API starts. */
export function checkApiResources(
  channels: Partial<Record<ChannelId, { resources: ResourceGate }>>,
  resourceKinds: ResourceKinds,
): void {
  const registry = channelRegistry();
  const kindOf = resourceKindOf({ ...KNOWN_RESOURCE_KINDS, ...resourceKinds });
  for (const channel of CHANNEL_IDS) {
    const resources = channels[channel]?.resources;
    if (resources !== undefined) {
      const adapter = registry.get(channel);
      assertCaptureGate(adapter.captureModes, resources.activities["captureProduct"] ?? [], kindOf);
    }
  }
}
