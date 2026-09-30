import { z } from "zod";
import { channelErrors } from "./errors.js";

/**
 * What a limited resource is (ARCHITECTURE.md, "Resources"). A permit's kind must match the work it guards:
 * `browser` an Ego browser space, `http-lane` the ScraperAPI lane, `file-lane` image downloads, `model` the Codex
 * account, `ocr` the OCR API, `cpu` local processing.
 */
export const RESOURCE_KINDS = ["browser", "http-lane", "file-lane", "model", "ocr", "cpu"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** A config's resource kinds, by resource ID. */
export const ResourceKindsSchema = z.record(z.string().min(1).max(200), z.enum(RESOURCE_KINDS));
export type ResourceKinds = z.infer<typeof ResourceKindsSchema>;

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

/** The kind of a resource, by its ID. */
export type ResourceKindOf = (resourceId: string) => ResourceKind;

/** Looks resource kinds up in a table; a resource with no kind stops the start instead of being guessed. */
export function resourceKindOf(kinds: ResourceKinds): ResourceKindOf {
  return (resourceId) => {
    const kind = kinds[resourceId];
    if (kind === undefined) {
      throw channelErrors.create("CHANNEL.RESOURCE_KIND_UNKNOWN", { details: { resourceId } });
    }
    return kind;
  };
}
