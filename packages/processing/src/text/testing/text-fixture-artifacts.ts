import { sha256 } from "@crawl-automation/platform";
import { ArtifactRefSchema, type ArtifactRef } from "@crawl-automation/v3-contracts";

export type Owner = {
  schemaVersion: 1;
  requestId: string;
  observationId: string;
  brandId: string;
  sourceId: string;
  listingId: string;
  variantId: null;
};

/** The label-core policy a fixture's facts document claims; the fixture supplies its re-derivation. */
export const LABEL_CORE_POLICY = "dtc-label-core/5";
export const LABEL_CORE_PRODUCER = {
  module: "label.core.prepare",
  implementationVersion: LABEL_CORE_POLICY,
};
const PAGE_PREPARE = { module: "page.prepare", implementationVersion: "fixture/1" };

/** A fixture artifact of the owner's observation, addressed by its bytes. */
export function fixtureArtifact(
  owner: Owner,
  kind: "source-html" | "result-json",
  made: {
    bytes: Uint8Array;
    suffix: string;
    producer?: { module: string; implementationVersion: string };
  },
): ArtifactRef {
  const { bytes } = made;
  return ArtifactRefSchema.parse({
    schemaVersion: 1,
    artifactId: `${made.suffix}-${owner.observationId}`,
    observationId: owner.observationId,
    sourceId: owner.sourceId,
    listingId: owner.listingId,
    variantId: null,
    kind,
    mediaType: kind === "source-html" ? "text/html" : "application/json",
    objectKey: `sources/${owner.observationId}/${made.suffix}`,
    sha256: sha256(bytes),
    byteSize: bytes.length,
    producer: { operationId: `prepare-${owner.observationId}`, ...(made.producer ?? PAGE_PREPARE) },
  });
}
