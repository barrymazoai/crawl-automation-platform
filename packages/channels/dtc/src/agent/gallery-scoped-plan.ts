import { sha256 } from "@crawl-automation/platform";
import {
  ChannelPlanInputSchema,
  ChannelProductEvidenceSchema,
  type ChannelProductEvidence,
  type DtcGalleryTask,
  type DtcVariantHandoff,
} from "@crawl-automation/v3-contracts";
import { GalleryStore, galleryEvidence as evidence } from "./gallery-store.js";

/** A variant's own plan over its share of a mixed gallery, saved beside the variant operation. */
export async function scopedPlan(
  store: GalleryStore,
  context: {
    member: Exclude<DtcVariantHandoff, { status: "review" }>;
    selected: DtcGalleryTask["images"];
    keepPageFacts?: boolean;
  },
  signal: AbortSignal,
) {
  const { member, selected } = context;
  const plan = member.planned.sourcePlan;
  const original = await store.read(plan.source, signal);
  const page = evidence(original);
  const scoped = ChannelProductEvidenceSchema.parse({
    ...page,
    factsCandidates: context.keepPageFacts ? sharedPageFacts(page.factsCandidates) : [],
    imageCandidates: selected.map((image) => ({
      url: image.url,
      variantId: member.variant.variantId,
      basis: "product-gallery",
      verifiedOriginal: false,
    })),
  });
  const projection =
    original && typeof original === "object" && "evidence" in original
      ? { ...original, evidence: scoped }
      : scoped;
  const ref = await store.save(
    `v3/dtc-agent/${member.operationId}/mixed-gallery/scoped-projection.json`,
    projection,
    signal,
  );
  const key = sha256(Buffer.from(JSON.stringify([plan.operationId, ref.sha256])));
  const sourcePlan = ChannelPlanInputSchema.parse({
    ...plan,
    operationId: `plan-dtc-scoped-${key}`,
    source: { ...plan.source, ...ref, artifactId: `source-dtc-scoped-${key}` },
  });
  return sourcePlan;
}

/**
 * One Facts text on the page serves every website variant (owner 2026-10-07, as one Facts picture does); several
 * different texts stay unassigned for the label step to treat as it does today.
 */
function sharedPageFacts(candidates: ChannelProductEvidence["factsCandidates"]) {
  return new Set(candidates.map((candidate) => candidate.html)).size === 1
    ? candidates.map((candidate) => ({ ...candidate, scope: "selected-product" as const }))
    : candidates;
}
