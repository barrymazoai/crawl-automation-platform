import { ApplicationFailure } from "@temporalio/workflow";
import { imageFirst, type Walk } from "./label-image-first.js";
import {
  assertManifest,
  finishLabel,
  labelManifest,
  permitFailures,
  reviewLabel,
} from "./label-finish.js";
import {
  LabelWorkflowInputSchema,
  LoadedPlanSchema,
  type Manifest,
  type State,
} from "./label-model.js";
import { labelRun, type LabelRun } from "./label-run.js";
import { processSource, type SourceWork } from "./label-source.js";
import { labelStream } from "./label-stream.js";
import { sameJson } from "./same.js";

/**
 * The Label workflow for every channel: load the product's label plan, prepare each source (page text, or image
 * OCR and keywords), run the text or vision model once per source, then publish the manifest, assemble and collect.
 * Image downloads arrive as signals from the pipeline. Every failure ends in a Review; nothing is retried.
 */
export async function LabelWorkflow(raw: unknown): Promise<unknown> {
  const entry = LabelWorkflowInputSchema.parse(raw);
  const run = labelRun(entry, labelStream(entry.input));
  const loaded = LoadedPlanSchema.parse(await run.call("activities", "loadLabelPlan", entry.input));
  const identity =
    sameJson(loaded.input, entry.input) &&
    sameJson(loaded.manifest.observation, entry.input.owner) &&
    loaded.manifest.operationId === entry.input.plan.operationId;
  if (!identity) {
    throw ApplicationFailure.nonRetryable(
      "Label plan identity conflict",
      "CHANNEL.LABEL_IDENTITY_CONFLICT",
    );
  }
  const work: SourceWork = { run, issued: new Map(), ocrPending: new Map() };
  const walk =
    entry.input.evidencePolicy === "label-image-first/5" ? await imageFirst(work, loaded) : null;
  const states = walk
    ? walk.states
    : await Promise.all(loaded.manifest.sources.map((source) => processSource(work, source)));
  const stopped = await stoppedEarly(run, states);
  if (stopped) {
    return stopped;
  }
  return finish(work, { manifest: loaded.manifest, states, walk });
}

/** A broken file stream, or sources held up by permits, end the product in its Review before any manifest. */
async function stoppedEarly(run: LabelRun, states: State[]): Promise<unknown> {
  if (!(await run.stream.finish())) {
    return reviewLabel(run, { states, code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED" });
  }
  if (run.waiting.length || run.quarantined.length) {
    return reviewLabel(run, {
      states,
      code: "CHANNEL.DEPENDENCY_UNAVAILABLE",
      failures: permitFailures(run),
    });
  }
  return null;
}

async function finish(
  work: SourceWork,
  at: { manifest: Manifest; states: State[]; walk: Walk | null },
): Promise<unknown> {
  const { states, walk } = at;
  const outcome = await labelManifest(work.run, walk);
  if (outcome.kind === "review") {
    return outcome.review;
  }
  const manifestResult = outcome.result;
  const all = walk ? [...walk.states, ...walk.notStarted] : states;
  assertManifest(work.run, { result: manifestResult, all, issued: work.issued });
  const selected = new Set(manifestResult.manifest.sources.map((source) => source.id));
  // Image-first: only selected sources count; a selected image the keyword screen missed is rejected, not skipped.
  const joined = states
    .filter(
      (state) =>
        selected.has(state.id) || (!walk && !["not_matched", "unresolved"].includes(state.status)),
    )
    .map((state): State =>
      selected.has(state.id) && state.status === "not_matched"
        ? { id: state.id, status: "rejected" }
        : state,
    );
  return finishLabel(work.run, { manifest: manifestResult.manifest, states: joined });
}
