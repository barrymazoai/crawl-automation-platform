import {
  ArtifactRefSchema,
  type ChannelPlanInput,
  type ChannelProductEvidence,
} from "@crawl-automation/v3-contracts";
import { fingerprinted, planTaskId } from "./plan-codec.js";

/** Retain product facts and details for evidence; label-section admission separately gates the model. */
export function fragmentOf(
  input: ChannelPlanInput,
  evidence: ChannelProductEvidence,
  sourceModule: string,
) {
  const selected = evidence.factsCandidates.filter((facts) => facts.scope === "selected-product");
  const html = [...selected.map((facts) => facts.html), evidence.detailsHtml]
    .filter(Boolean)
    .join("\n");
  const bytes = Buffer.from(html);
  if (!html) {
    return { fragment: null, bytes };
  }
  const { owner, operationId } = input;
  const fragment = ArtifactRefSchema.parse({
    schemaVersion: 1,
    artifactId: planTaskId(operationId, "fragment"),
    observationId: owner.observationId,
    sourceId: owner.sourceId,
    listingId: owner.listingId,
    variantId: owner.variantId,
    kind: "source-html",
    mediaType: "text/html",
    objectKey: `v3/channel-plans/${operationId}/derived.html`,
    byteSize: bytes.length,
    sha256: fingerprinted(html),
    producer: { operationId, module: sourceModule, implementationVersion: "channel-plan/1" },
  });
  return { fragment, bytes };
}
