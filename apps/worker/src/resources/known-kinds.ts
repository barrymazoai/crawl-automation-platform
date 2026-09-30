import type { ResourceKinds } from "@crawl-automation/channels-core";

/**
 * The kinds of the resources the machine configs name today (2026-09-30), so those configs keep starting without a
 * `resourceKinds` section. A config's own `resourceKinds` wins; any other resource must be given a kind there.
 */
export const KNOWN_RESOURCE_KINDS: ResourceKinds = {
  "scraperapi-lane": "http-lane",
  "mini-model-account": "model",
  "mini-cpu": "cpu",
  "windows-ocr": "ocr",
};
