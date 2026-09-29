import type { SavedEvidenceSource } from "@crawl-automation/v3-contracts";
import { labelFailure } from "./label-errors.js";
import { LabelSelectionSchema, type SourceState } from "./label-plan-model.js";
import type { LabelPlans } from "./label-plans.js";
import type { LabelInspection, SelectionContext } from "./selection-model.js";

const FILE_CHECKS_AT_ONCE = 4;
const unverified = () => labelFailure("CHANNEL.LABEL_SELECTION_UNVERIFIED");

/** The selection with its loaded plan: every source has exactly one state, and the images their attempt order. */
export async function selectionContext(
  plans: LabelPlans,
  raw: unknown,
  signal: AbortSignal,
): Promise<SelectionContext> {
  const selection = LabelSelectionSchema.parse(raw);
  const loaded = await plans.load(selection.input, signal);
  const states = new Map(selection.states.map((state) => [state.id, state]));
  const sources = loaded.manifest.sources;
  const complete = states.size === selection.states.length && states.size === sources.length;
  if (!complete || sources.some((source) => !states.has(source.id))) {
    throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
  }
  const order = loaded.imageOrder ?? [];
  const selected = selection.selectedImageId;
  const selectedIndex = selected === null ? -1 : order.indexOf(selected);
  return { selection, loaded, states, order, selectedIndex, signal };
}

/** Every downloaded image is still retained, checked a few at a time and settled before anything is published. */
export async function assertFilesRetained(
  inspection: LabelInspection,
  context: SelectionContext,
): Promise<void> {
  const files = context.loaded.manifest.sources.filter((source) => source.kind === "file-image");
  for (let offset = 0; offset < files.length; offset += FILE_CHECKS_AT_ONCE) {
    const batch = files.slice(offset, offset + FILE_CHECKS_AT_ONCE);
    const checks = await Promise.allSettled(
      batch.map((source) => inspection.file(source, context.signal)),
    );
    for (const check of checks) {
      if (check.status === "rejected") {
        throw check.reason;
      }
      if (!check.value) {
        throw labelFailure("CHANNEL.LABEL_FILE_UNVERIFIED");
      }
    }
  }
}

/** A source's state must be a finished one: never unresolved or rejected. */
export function finishedState(source: SavedEvidenceSource, context: SelectionContext): SourceState {
  const state = context.states.get(source.id);
  if (!state || state.status === "unresolved" || state.status === "rejected") {
    throw labelFailure("CHANNEL.LABEL_PREPARATION_UNVERIFIED");
  }
  return state;
}

/**
 * Where a source stands against the selected image. An unstarted source may be skipped only once an image was
 * selected, and only if it is a page or an image after the selected one; an image after the selected one must be
 * unstarted.
 */
export function assertInOrder(
  source: SavedEvidenceSource,
  at: { state: SourceState; context: SelectionContext },
): void {
  const { state, context } = at;
  const laterImage =
    source.kind === "file-image" && context.order.indexOf(source.id) > context.selectedIndex;
  if (state.status === "not_started") {
    if (context.selectedIndex < 0 || (source.kind !== "page" && !laterImage)) {
      throw unverified();
    }
    return;
  }
  if (laterImage && context.selectedIndex >= 0) {
    throw unverified();
  }
}
