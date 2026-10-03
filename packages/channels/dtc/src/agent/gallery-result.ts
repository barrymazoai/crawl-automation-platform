import {
  DtcGalleryImageResultSchema,
  readGalleryResults,
  selectedGalleryImages,
} from "./gallery-decisions.js";
export { DtcGalleryImageResultSchema, validateGalleryDecision } from "./gallery-decisions.js";
import { z } from "zod";
import { sha256 } from "@crawl-automation/platform";
import {
  ChannelProductEvidenceSchema,
  ChannelPlanInputSchema,
  type DtcGalleryRef,
  type DtcGalleryTask,
  type DtcVariantHandoff,
} from "@crawl-automation/v3-contracts";
import { GalleryStore, galleryEvidence as evidence } from "./gallery-store.js";
import {
  GallerySelectionProof,
  verifyGallerySelection,
  type GallerySelection,
} from "./gallery-selection-proof.js";
export async function finishGallery(
  store: GalleryStore,
  input: {
    task: DtcGalleryRef;
    decisions: DtcGalleryRef[];
    selections?: DtcGalleryRef[] | undefined;
  },
  signal: AbortSignal,
) {
  const task = await store.task(input.task, signal);
  const results = await readGalleryResults(store, input, signal);
  const selections = await readSelections(store, { input, task, results }, signal);
  const members: DtcVariantHandoff[] = [];
  for (const member of task.variants) {
    members.push(
      await resolveMember(
        store,
        {
          task,
          results,
          member,
          selections,
          refs: [...input.decisions, ...(input.selections ?? [])],
        },
        signal,
      ),
    );
  }
  await store.save(
    `${input.task.objectKey.slice(0, -"task.json".length)}resolved.json`,
    members,
    signal,
  );
  return members;
}
async function readSelections(
  store: GalleryStore,
  context: {
    input: { task: DtcGalleryRef; selections?: DtcGalleryRef[] | undefined };
    task: DtcGalleryTask;
    results: MemberContext["results"];
  },
  signal: AbortSignal,
) {
  const { input, task, results } = context;
  const selections: GallerySelection[] = [];
  for (const ref of input.selections ?? []) {
    const proof = GallerySelectionProof.parse(await store.read(ref, signal));
    const member = task.variants.find((item) => item.variant.variantId === proof.variantId);
    if (
      member?.status !== "mixed" ||
      selections.some((item) => item.variantId === proof.variantId)
    ) {
      throw new Error("DTC.GALLERY_SELECTION_OWNER");
    }
    selections.push(
      verifyGallerySelection(proof, {
        task: input.task,
        variantId: proof.variantId,
        candidateImageIds: selectedGalleryImages(task, results, proof.variantId).map(
          (image) => image.input.file.artifactId,
        ),
      }),
    );
  }
  return selections;
}
interface MemberContext {
  task: DtcGalleryTask;
  results: z.infer<typeof DtcGalleryImageResultSchema>[];
  member: DtcVariantHandoff;
  refs: DtcGalleryRef[];
  selections: GallerySelection[];
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
  let selected = selectedGalleryImages(task, results, member.variant.variantId ?? "");
  const selection = context.selections.find(
    (proof) => proof.variantId === member.variant.variantId,
  );
  if (selected.length > 1 && selection?.decision.selectedImageId) {
    selected = selected.filter(
      (image) => image.input.file.artifactId === selection.decision.selectedImageId,
    );
  }
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
