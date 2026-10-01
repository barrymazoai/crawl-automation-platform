import { isCancellation, log } from "@temporalio/workflow";
import { z } from "zod";
import { processSource, type SourceWork } from "./label-source.js";
import { type LoadedPlanSchema, type Source, type State } from "./label-model.js";
import { identityConflict } from "./identity-conflict.js";
import { sameJson } from "./same.js";
import { noteSourceFailure } from "./label-run.js";
import { SourceFailureSchema, type OrderedWalk } from "./label-ordered-model.js";
export type { OrderedWalk } from "./label-ordered-model.js";
import { admissionDocuments } from "./label-admission.js";

type Loaded = z.infer<typeof LoadedPlanSchema>;
const ProgressSchema = z.strictObject({
  input: z.unknown(),
  complete: z.boolean(),
  terminal: z.boolean(),
  reason: SourceFailureSchema.optional(),
});

/** One source at a time, including acquisition and OCR; only verified completeness stops fallback. */
export async function orderedLabel(work: SourceWork, loaded: Loaded): Promise<OrderedWalk> {
  const sources = sourceOrder(loaded);
  const walk: OrderedWalk = {
    ordered: true,
    complete: false,
    states: [],
    notStarted: [],
    selectedImageId: null,
  };
  for (const source of sources) {
    log.info("Label source selected", {
      sourceId: source.id,
      order: work.run.entry.input.sourcePolicy?.order,
      reason: walk.states.length ? "earlier_source_incomplete" : "channel_source_order",
    });
    walk.states.push(await processSource(work, source));
    if (!(await checkProgress(work, walk))) {
      break;
    }
  }
  await admissionDocuments(work.run, { loaded, walk });
  const seen = new Set(walk.states.map((state) => state.id));
  for (const source of loaded.manifest.sources.filter((source) => !seen.has(source.id))) {
    const noLabel = source.kind === "page" && !loaded.labelPreparation?.pageHasLabelSection;
    const reason = noLabel
      ? "no_label_section"
      : walk.complete
        ? "complete_label_already_selected"
        : "source_execution_unverified";
    log.info("Label source skipped", { sourceId: source.id, reason });
    walk.notStarted.push({ id: source.id, status: "not_started" });
  }
  return walk;
}

function sourceOrder(loaded: Loaded): Source[] {
  const { sourcePolicy } = loaded.input;
  if (!sourcePolicy || !loaded.labelPreparation) {
    throw identityConflict();
  }
  const images = loaded.manifest.sources.filter((source) => source.kind === "file-image");
  const order = loaded.imageOrder ?? [];
  if (
    new Set(order).size !== images.length ||
    order.length !== images.length ||
    images.some((source) => !order.includes(source.id))
  ) {
    throw identityConflict();
  }
  images.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
  const pages = loaded.manifest.sources.filter(
    (source) => source.kind === "page" && loaded.labelPreparation?.pageHasLabelSection,
  );
  return sourcePolicy.order === "images-first" ? [...images, ...pages] : [...pages, ...images];
}

async function checkProgress(work: SourceWork, walk: OrderedWalk): Promise<boolean> {
  const request = { input: work.run.entry.input, states: [...walk.states] };
  try {
    const check = ProgressSchema.parse(
      await work.run.call("activities", "inspectLabelImage", request),
    );
    if (!sameJson(check.input, request)) {
      throw identityConflict();
    }
    walk.complete = check.complete;
    log.info("Label source inspected", {
      complete: check.complete,
      terminal: check.terminal,
      reason: check.reason,
    });
    if (check.reason) {
      walk.reason = check.reason;
    }
    return !check.complete && !check.terminal;
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    const last = walk.states.at(-1) as State;
    walk.states[walk.states.length - 1] = { id: last.id, status: "unresolved" };
    noteSourceFailure(work.run, last.id, error);
    walk.reason = {
      sourceId: last.id,
      code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
      executionFact: "unknown",
    };
    return false;
  }
}
