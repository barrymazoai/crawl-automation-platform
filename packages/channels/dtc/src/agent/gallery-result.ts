import { z } from "zod";
import { sha256 } from "@crawl-automation/platform";
import {
  ChannelProductEvidenceSchema,
  ChannelPlanInputSchema,
  DtcGalleryDecisionSchema,
  DtcGalleryRefSchema,
  type DtcGalleryRef,
  type DtcGalleryTask,
  type DtcVariantHandoff,
} from "@crawl-automation/v3-contracts";
import { GalleryStore, galleryEvidence as evidence } from "./gallery-store.js";
export const DtcGalleryImageResultSchema = z.strictObject({
  task: DtcGalleryRefSchema,
  imageId: z.string(),
  decision: DtcGalleryDecisionSchema,
  ocr: DtcGalleryRefSchema,
});

export async function finishGallery(
  store: GalleryStore,
  input: { task: DtcGalleryRef; decisions: DtcGalleryRef[] },
  signal: AbortSignal,
) {
  const task = await store.task(input.task, signal);
  const results = await readResults(store, input, signal);
  const members: DtcVariantHandoff[] = [];
  for (const member of task.variants) {
    members.push(
      await resolveMember(store, { task, results, member, refs: input.decisions }, signal),
    );
  }
  await store.save(
    `${input.task.objectKey.slice(0, -"task.json".length)}resolved.json`,
    members,
    signal,
  );
  return members;
}
async function readResults(
  store: GalleryStore,
  input: { task: DtcGalleryRef; decisions: DtcGalleryRef[] },
  signal: AbortSignal,
) {
  const task = await store.task(input.task, signal);
  const results: z.infer<typeof DtcGalleryImageResultSchema>[] = [];
  for (const ref of input.decisions) {
    const result = DtcGalleryImageResultSchema.parse(await store.read(ref, signal));
    if (JSON.stringify(result.task) !== JSON.stringify(input.task)) {
      throw new Error("DTC.GALLERY_RESULT_OWNER");
    }
    results.push(result);
  }
  if (
    results.length !== task.images.length ||
    new Set(results.map((item) => item.imageId)).size !== results.length ||
    task.images.some(
      (image) => !results.some((result) => result.imageId === image.input.file.artifactId),
    )
  ) {
    throw new Error("DTC.GALLERY_RESULTS_INCOMPLETE");
  }
  for (const result of results) {
    validateGalleryDecision(task, result.decision);
  }
  return results;
}
interface MemberContext {
  task: DtcGalleryTask;
  results: z.infer<typeof DtcGalleryImageResultSchema>[];
  member: DtcVariantHandoff;
  refs: DtcGalleryRef[];
}
async function resolveMember(
  store: GalleryStore,
  context: MemberContext,
  signal: AbortSignal,
): Promise<DtcVariantHandoff> {
  const { task, results, member, refs } = context;
  if (member.status !== "mixed") {
    return member;
  }
  const unresolved = results.some((result) => result.decision.kind === "unresolved");
  const selected = task.images.filter((image) =>
    results.some(
      (result) =>
        result.imageId === image.input.file.artifactId &&
        result.decision.kind === "facts" &&
        result.decision.variantIds.includes(member.variant.variantId ?? ""),
    ),
  );
  const proof = [...member.evidence, ...refs.map((ref) => ref.objectKey)].slice(0, 200);
  if (unresolved || selected.length !== 1) {
    return scopeReview(member, proof, { unresolved, count: selected.length });
  }
  const sourcePlan = await scopedPlan(store, { member, selected }, signal);
  return {
    ...member,
    status: "ready",
    evidence: proof,
    planned: {
      status: "captured",
      sourcePlan,
      factsComplete: false,
      labelText: null,
      family: null,
    },
  };
}
async function scopedPlan(
  store: GalleryStore,
  context: {
    member: Exclude<DtcVariantHandoff, { status: "review" }>;
    selected: DtcGalleryTask["images"];
  },
  signal: AbortSignal,
) {
  const { member, selected } = context;
  const plan = member.planned.sourcePlan;
  const original = await store.read(plan.source, signal);
  const scoped = ChannelProductEvidenceSchema.parse({
    ...evidence(original),
    factsCandidates: [],
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
export function validateGalleryDecision(task: DtcGalleryTask, raw: unknown) {
  const decision = DtcGalleryDecisionSchema.parse(raw);
  const ids = task.websiteVariants.map((variant) => variant.variantId);
  if (
    new Set(decision.variantIds).size !== decision.variantIds.length ||
    decision.variantIds.some((id) => !ids.includes(id))
  ) {
    throw new Error("DTC.GALLERY_INVENTED_VARIANT");
  }
  if (
    decision.kind === "facts" &&
    (!decision.variantIds.length ||
      !decision.imageEvidence.trim() ||
      !decision.websiteEvidence.trim() ||
      !["label-content", "website-shared"].includes(decision.basis))
  ) {
    throw new Error("DTC.GALLERY_SCOPE_UNPROVEN");
  }
  if (decision.kind !== "facts" && decision.variantIds.length) {
    throw new Error("DTC.GALLERY_SCOPE_UNPROVEN");
  }
  return decision;
}

function scopeReview(
  member: DtcVariantHandoff,
  proof: string[],
  context: { unresolved: boolean; count: number },
): DtcVariantHandoff {
  return {
    operationId: member.operationId,
    variant: member.variant,
    evidence: proof,
    status: "review",
    code: "DTC.VARIANT_EVIDENCE",
    reason: context.unresolved
      ? "Mixed gallery contains unresolved Facts evidence"
      : context.count === 0
        ? "No Facts image assigned to this website variant"
        : "Multiple Facts panels require joint review; no first-image fallback",
  };
}
