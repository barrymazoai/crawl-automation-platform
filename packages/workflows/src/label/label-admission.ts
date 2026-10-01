import { isCancellation } from "@temporalio/workflow";
import type { LoadedPlanSchema } from "./label-model.js";
import type { z } from "zod";
import { pageEvidence } from "./label-page.js";
import { noteSourceFailure, type LabelRun } from "./label-run.js";
import type { OrderedWalk } from "./label-ordered-model.js";

/** Packaging admission still reads page evidence when its text model was skipped. */
export async function admissionDocuments(
  run: LabelRun,
  at: {
    loaded: z.infer<typeof LoadedPlanSchema>;
    walk: OrderedWalk;
  },
) {
  if (!run.entry.input.admission || !at.walk.complete) {
    return;
  }
  const attempted = new Set(at.walk.states.map((state) => state.id));
  const pages = at.loaded.manifest.sources.filter(
    (source) => source.kind === "page" && !attempted.has(source.id),
  );
  const { corePolicy: _unused, ...input } = run.entry.input;
  const fullPageRun = { ...run, entry: { ...run.entry, input } };
  for (const source of pages) {
    if (source.kind !== "page") {
      continue;
    }
    try {
      const prepared = await pageEvidence(fullPageRun, source);
      if ("status" in prepared) {
        at.walk.states.push(prepared);
        at.walk.complete = false;
      }
    } catch (error) {
      if (isCancellation(error)) {
        throw error;
      }
      noteSourceFailure(run, source.id, error);
      at.walk.states.push({ id: source.id, status: "unresolved" });
      at.walk.complete = false;
    }
    if (!at.walk.complete) {
      admissionFailure(at.walk, source.id);
      return;
    }
  }
}

function admissionFailure(walk: OrderedWalk, sourceId: string) {
  walk.reason = {
    sourceId,
    code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
    executionFact: "unknown",
  };
}
