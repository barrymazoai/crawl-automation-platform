import { ExecutionIdSchema, observationIdentity } from "@crawl-automation/v3-contracts";
import { isCancellation } from "@temporalio/workflow";
import { ocrImage, type OcrOutcome } from "./label-image-ocr.js";
import { pageEvidence, type PageOutcome } from "./label-page.js";
import { notePermitFailure, type LabelRun } from "./label-run.js";
import { runText } from "./label-text.js";
import { SourceResultSchema, type Source, type State, type Status } from "./label-model.js";
import { sameJson } from "./same.js";

/** What a source's own preparation produced: a page's text document, or an image's keyword selection. */
type Evidence =
  { kind: "page"; document: unknown; range: unknown } | { kind: "image"; selection: unknown };

/** The label tasks this run issued, by source; the manifest must list exactly these. */
export type Issued = Map<string, unknown>;

export interface SourceWork {
  run: LabelRun;
  issued: Issued;
  /** OCR already started for this image (image-first tasks start it up front). */
  ocrPending: Map<string, Promise<OcrOutcome>>;
}

const stateOf = (source: Source, status: Status): State => ({ id: source.id, status });

/** One source through its preparation, its label task and the model; any failure is that source's state. */
export async function processSource(work: SourceWork, source: Source): Promise<State> {
  try {
    const evidence = await prepared(work, source);
    if ("status" in evidence) {
      return evidence;
    }
    return await labelTask(work, { source, evidence });
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    notePermitFailure(work.run, source.id, error);
    return stateOf(source, "unresolved");
  }
}

async function prepared(work: SourceWork, source: Source): Promise<Evidence | State> {
  if (source.kind === "page") {
    if (!(await work.run.stream.ready(source))) {
      return stateOf(source, "unresolved");
    }
    const page: PageOutcome = await pageEvidence(work.run, source);
    return "status" in page ? page : { kind: "page", ...page };
  }
  if (source.kind !== "file-image") {
    return stateOf(source, "rejected");
  }
  const outcome = await (work.ocrPending.get(source.id) ?? ocrImage(work.run, source));
  return outcome.kind === "state" ? outcome.state : { kind: "image", selection: outcome.selection };
}

async function labelTask(
  work: SourceWork,
  at: { source: Source; evidence: Evidence },
): Promise<State> {
  const { source, evidence } = at;
  const { run } = work;
  const request = { input: run.entry.input, sourceId: source.id };
  const result = SourceResultSchema.parse(
    await run.call("activities", "prepareLabelSource", request),
  );
  if (!sameJson(result.input, request)) {
    return stateOf(source, "rejected");
  }
  if (result.status === "not_matched") {
    const unmatched =
      evidence.kind === "image" &&
      (evidence.selection as { status?: string }).status === "not_matched";
    return stateOf(source, unmatched ? "not_matched" : "rejected");
  }
  const next = result.source;
  if (
    next.id !== source.id ||
    !next.required ||
    next.kind !== (evidence.kind === "page" ? "text" : "image")
  ) {
    return stateOf(source, "rejected");
  }
  if (next.kind === "text") {
    return textSource(work, { source, next, evidence });
  }
  return imageSource(work, { source, next, evidence });
}

type Prepared = Extract<
  ReturnType<typeof SourceResultSchema.parse>,
  { status: "prepared" }
>["source"];

async function textSource(
  work: SourceWork,
  at: { source: Source; next: Extract<Prepared, { kind: "text" }>; evidence: Evidence },
): Promise<State> {
  const { source, next, evidence } = at;
  const task = next.task;
  const input = work.run.entry.input;
  const textSettings = Object.entries(input.text) as [keyof typeof task, unknown][];
  const fits =
    evidence.kind === "page" &&
    task.source.kind === "prepared" &&
    sameJson(task.source.document, evidence.document) &&
    sameJson(task.range, evidence.range) &&
    sameJson(observationIdentity(task), input.owner) &&
    textSettings.every(([key, value]) => task[key] === value);
  if (!fits) {
    return stateOf(source, "rejected");
  }
  work.issued.set(source.id, next);
  return runText(work.run, { id: source.id, task });
}

async function imageSource(
  work: SourceWork,
  at: { source: Source; next: Extract<Prepared, { kind: "image" }>; evidence: Evidence },
): Promise<State> {
  const { source, next, evidence } = at;
  const { run } = work;
  const fits =
    evidence.kind === "image" &&
    sameJson(next.task.input.selection, evidence.selection) &&
    next.task.configFingerprint === run.entry.input.visionConfigFingerprint;
  if (!fits) {
    return stateOf(source, "rejected");
  }
  work.issued.set(source.id, next);
  const result = (await run.call("model", "interpretImage", next.task)) as {
    status?: string;
    operationId?: string;
    reviewId?: string;
  } | null;
  if (result?.status === "review" && ExecutionIdSchema.safeParse(result.reviewId).success) {
    return { id: source.id, status: "review", reviewId: result.reviewId as string };
  }
  const done =
    result?.status === "registered" && result.operationId === next.task.input.operationId;
  return stateOf(source, done ? "registered" : "rejected");
}
