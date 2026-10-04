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

export async function sharingEvidence(
  store: GalleryStore,
  context: {
    input: {
      task: DtcGalleryRef;
      decisions: DtcGalleryRef[];
      selections?: DtcGalleryRef[] | undefined;
    };
    task: DtcGalleryTask;
    results: Decisions;
  },
  signal: AbortSignal,
) {
  const { input, task, results } = context;
  const refs = [...input.decisions, ...(input.selections ?? [])];
  const shared = singleFactsImage(task, results);
  if (shared) {
    refs.push(
      await store.save(
        `${input.task.objectKey.slice(0, -"task.json".length)}single-facts-policy.json`,
        {
          policy: "dtc-single-facts/1",
          basis: "user-accepted-product-level-sharing",
          task: input.task,
          decisions: input.decisions,
          imageId: shared.input.file.artifactId,
          variantIds: task.variants
            .filter((member) => member.status === "mixed")
            .map((member) => member.variant.variantId),
          reason:
            "The product provides one legible Facts panel; preserve each website variant's metadata and share this panel.",
        },
        signal,
      ),
    );
  }
  return refs;
}
