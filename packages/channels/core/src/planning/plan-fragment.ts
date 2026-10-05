import {
  ArtifactRefSchema,
  type ChannelPlanInput,
  type ChannelProductEvidence,
} from "@crawl-automation/v3-contracts";
import { fingerprinted, planTaskId } from "./plan-codec.js";
import { hasIngredientsSection } from "./source-order.js";

/**
 * The page text the label model reads: product facts, plus details only when no facts block prints its own
 * ingredient list. Marketing bullets and descriptions next to a complete ingredient list only become excluded
 * text that leaves the label's coverage uncertain (owner 2026-10-05).
 */
export function fragmentOf(
  input: ChannelPlanInput,
  evidence: ChannelProductEvidence,
  sourceModule: string,
) {
  const facts = evidence.factsCandidates
    .filter((candidate) => candidate.scope === "selected-product")
    .map((candidate) => candidate.html);
  const details = facts.some(hasIngredientsSection) ? null : evidence.detailsHtml;
  const html = [...new Set([...facts, details])].filter(Boolean).join("\n");
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
