import type {
  DtcGalleryDecision,
  DtcGalleryRef,
  DtcGalleryTask,
} from "@crawl-automation/v3-contracts";
import type { GalleryStore } from "./gallery-store.js";

type Decisions = ReadonlyArray<{ imageId: string; decision: DtcGalleryDecision }>;

/** A product's sole readable panel may serve its website variants under the accepted DTC policy. */
export function singleFactsImage(task: DtcGalleryTask, results: Decisions) {
  const facts = results.filter((result) => result.decision.kind === "facts");
  if (facts.length !== 1 || results.some((result) => result.decision.kind === "unresolved")) {
    return undefined;
  }
  return task.images.find((image) => image.input.file.artifactId === facts[0]?.imageId);
}

/**
 * No gallery image is a Facts panel (owner 2026-10-07): there is nothing to assign, so each website variant keeps its
 * own saved page material and the normal label step reads it, as for a single-variant product.
 */
export function noGalleryFacts(results: Decisions): boolean {
  return results.length > 0 && results.every((result) => result.decision.kind === "other");
}

interface SharingContext {
  input: {
    task: DtcGalleryRef;
    decisions: DtcGalleryRef[];
    selections?: DtcGalleryRef[] | undefined;
  };
  task: DtcGalleryTask;
  results: Decisions;
}

export async function sharingEvidence(
  store: GalleryStore,
  context: SharingContext,
  signal: AbortSignal,
) {
  const { input, task, results } = context;
  const refs = [...input.decisions, ...(input.selections ?? [])];
  if (noGalleryFacts(results)) {
    refs.push(
      await savePolicy(store, signal, {
        context,
        file: "no-gallery-facts-policy.json",
        policy: "dtc-no-gallery-facts/1",
        reason:
          "No gallery image is a Facts panel; each website variant continues with its own saved page material.",
      }),
    );
  }
  const shared = singleFactsImage(task, results);
  if (shared) {
    refs.push(
      await savePolicy(store, signal, {
        context,
        file: "single-facts-policy.json",
        policy: "dtc-single-facts/1",
        imageId: shared.input.file.artifactId,
        reason:
          "The product provides one legible Facts panel; preserve each website variant's metadata and share this panel.",
      }),
    );
  }
  return refs;
}

/** The accepted product-level sharing policy, recorded beside the gallery task it applied to. */
function savePolicy(
  store: GalleryStore,
  signal: AbortSignal,
  record: {
    context: SharingContext;
    file: string;
    policy: string;
    reason: string;
    imageId?: string;
  },
) {
  const { context, file, ...fields } = record;
  const { input, task } = context;
  return store.save(
    `${input.task.objectKey.slice(0, -"task.json".length)}${file}`,
    {
      ...fields,
      basis: "user-accepted-product-level-sharing",
      task: input.task,
      decisions: input.decisions,
      variantIds: task.variants
        .filter((member) => member.status === "mixed")
        .map((member) => member.variant.variantId),
    },
    signal,
  );
}
