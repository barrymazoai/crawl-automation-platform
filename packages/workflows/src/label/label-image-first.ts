import { isCancellation } from "@temporalio/workflow";
import { ocrImage } from "./label-image-ocr.js";
import { processSource, type SourceWork } from "./label-source.js";
import { ImageCheckSchema, type ImageSource, type Manifest, type State } from "./label-model.js";
import { identityConflict } from "./identity-conflict.js";
import { sameJson } from "./same.js";
import { noteSourceFailure } from "./label-run.js";

export interface Walk {
  states: State[];
  notStarted: { id: string; status: "not_started" }[];
  selectedImageId: string | null;
}

/**
 * Image-first labels: every image's OCR starts at once (cheap), then images are tried in order and the image model
 * stops at the first complete label. Every original stays required evidence; only model work is skipped.
 */
export async function imageFirst(
  work: SourceWork,
  plan: { manifest: Manifest; imageOrder?: string[] | undefined },
): Promise<Walk> {
  const images = plan.manifest.sources.filter(
    (source): source is ImageSource => source.kind === "file-image",
  );
  const order = checkedOrder(images, plan.imageOrder);
  for (const id of order) {
    work.ocrPending.set(id, ocrImage(work.run, imageOf(images, id)));
  }
  const walk: Walk = { states: [], notStarted: [], selectedImageId: null };
  for (const id of order) {
    if (!(await tryImage(work, { walk, source: imageOf(images, id) }))) {
      break;
    }
  }
  // Whatever ended the walk, every OCR started is awaited: an abandoned activity would keep its OCR permit.
  await Promise.allSettled([...work.ocrPending.values()]);
  for (const source of plan.manifest.sources.filter((entry) => entry.kind !== "file-image")) {
    if (walk.selectedImageId && source.kind === "page") {
      walk.notStarted.push({ id: source.id, status: "not_started" });
    } else {
      walk.states.push(await processSource(work, source));
    }
  }
  await accountForRest(work, { walk, images });
  return walk;
}

/** One image in order; false when the walk must stop here. */
async function tryImage(
  work: SourceWork,
  at: { walk: Walk; source: ImageSource },
): Promise<boolean> {
  const { walk, source } = at;
  if (walk.selectedImageId) {
    const outcome = await work.ocrPending.get(source.id);
    const stuck = outcome?.kind === "state" && !outcome.ready;
    if (stuck) {
      walk.states.push({ id: source.id, status: "unresolved" });
    } else {
      walk.notStarted.push({ id: source.id, status: "not_started" });
    }
    return true;
  }
  const state = await processSource(work, source);
  walk.states.push(state);
  if (state.status === "registered") {
    return checkComplete(work, { walk, source });
  }
  return state.status !== "unresolved" && state.status !== "rejected";
}

/** Whether the registered image holds a complete, intact label; an unknown answer stops the walk. */
async function checkComplete(
  work: SourceWork,
  at: { walk: Walk; source: ImageSource },
): Promise<boolean> {
  const { walk, source } = at;
  const request = { input: work.run.entry.input, sourceId: source.id };
  try {
    const check = ImageCheckSchema.parse(
      await work.run.call("activities", "inspectLabelImage", request),
    );
    if (!sameJson(check.input, request)) {
      throw identityConflict();
    }
    if (check.complete) {
      walk.selectedImageId = source.id;
    }
    return true;
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    walk.states[walk.states.length - 1] = { id: source.id, status: "unresolved" };
    noteSourceFailure(work.run, source.id, error);
    return false;
  }
}

/** Images the walk never reached are unresolved; an unknown execution never counts as done. */
async function accountForRest(
  work: SourceWork,
  at: { walk: Walk; images: ImageSource[] },
): Promise<void> {
  const { walk, images } = at;
  const seen = new Set([...walk.states, ...walk.notStarted].map((state) => state.id));
  for (const source of images.filter((image) => !seen.has(image.id))) {
    await work.run.stream.ready(source);
    walk.states.push({ id: source.id, status: "unresolved" });
  }
}

function checkedOrder(images: ImageSource[], order: string[] | undefined): string[] {
  const complete =
    !!order &&
    order.length === images.length &&
    new Set(order).size === images.length &&
    images.every((image) => order.includes(image.id));
  if (!complete || !order) {
    throw identityConflict();
  }
  return order;
}

function imageOf(images: ImageSource[], id: string): ImageSource {
  const image = images.find((entry) => entry.id === id);
  if (!image) {
    throw identityConflict();
  }
  return image;
}
