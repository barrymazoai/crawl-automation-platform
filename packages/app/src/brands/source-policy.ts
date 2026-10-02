import type { ChannelId, ChannelRegistry } from "@crawl-automation/channels-core";
import { appErrors } from "../errors.js";

/** Channel configuration is authoritative; services never interpret catalog paths or infer a brand. */
export function assertSourcePolicy(
  registry: ChannelRegistry | undefined,
  source: { channel: string; url: string; brandName?: string | undefined },
): void {
  if (source.channel !== "dtc") {
    return;
  }
  const adapter = registry?.get(source.channel as ChannelId);
  if (!adapter?.assertBrandSource) {
    throw appErrors.create("BRAND_SCAN.NOT_CONFIGURED");
  }
  adapter.assertBrandSource({ url: source.url, brandName: source.brandName ?? "" });
}
