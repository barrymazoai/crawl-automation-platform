import { isDeepStrictEqual } from "node:util";
import { sha256 } from "@crawl-automation/v3-artifacts";
import {
  LabelCoreOutcomeSchema,
  TextInputSchema,
  observationIdentity,
  textFingerprint,
  type ArtifactRef,
  type ProductResolvedEvidenceSource,
  type SavedEvidenceSource,
} from "@crawl-automation/v3-contracts";
import { encodeJson, hashString } from "../results/result-record.js";
import { labelFailure } from "./label-errors.js";
import type { LabelPlanInput, LabelSourceRequest, LabelSourceResult } from "./label-plan-model.js";

type Resolved = ProductResolvedEvidenceSource;
type TextSource = Extract<Resolved, { kind: "text" }>;
type ImageSource = Extract<Resolved, { kind: "image" }>;

/** Reads a label-core document for a full page (the label-core step's inspect). */
export interface LabelCoreReader {
  inspect(raw: unknown, signal: AbortSignal): Promise<unknown>;
}

const conflict = () => labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");

/** The label task's own operation for one source. */
export const labelSourceOperation = (input: LabelPlanInput, sourceId: string) =>
  `chl-${sha256(encodeJson([input.operationId, sourceId]))}`;

/**
 * Turns one prepared source into its label-protocol task: a page's text task (on its label core when the task has a
 * core policy) or an image's vision task. Page tasks of the old protocol are never sent to a label model.
 */
export async function labelSourceTask(
  request: LabelSourceRequest,
  prepared: { source: SavedEvidenceSource; resolved: Resolved },
  core: { reader?: LabelCoreReader | undefined; signal: AbortSignal },
): Promise<LabelSourceResult> {
  const { input } = request;
  const { source, resolved } = prepared;
  const owner =
    resolved.kind === "text"
      ? observationIdentity(resolved.task)
      : resolved.task.input.selection.observation;
  const expectedKind = source.kind === "page" ? "text" : "image";
  if (
    resolved.id !== source.id ||
    resolved.kind !== expectedKind ||
    !isDeepStrictEqual(owner, input.owner)
  ) {
    throw conflict();
  }
  const operationId = labelSourceOperation(input, source.id);
  const task =
    resolved.kind === "text"
      ? await labelTextTask(input, { source, resolved, operationId }, core)
      : labelImageTask(input, { source, resolved, operationId });
  return { status: "prepared", input: request, source: task };
}

async function labelTextTask(
  input: LabelPlanInput,
  prepared: { source: SavedEvidenceSource; resolved: TextSource; operationId: string },
  core: { reader?: LabelCoreReader | undefined; signal: AbortSignal },
) {
  const { source, resolved, operationId } = prepared;
  const { task } = resolved;
  const own =
    source.kind === "page" &&
    task.operationId === source.plan.textOperationId &&
    task.source.kind === "prepared" &&
    task.range.start === 0 &&
    task.source.document.producer.operationId === source.plan.page.operationId;
  if (!own || task.source.kind !== "prepared") {
    throw conflict();
  }
  const { inputFingerprint: _previous, ...base } = task;
  if (input.corePolicy) {
    const prepared = await labelCore(input, task.source.document, core);
    base.source = { kind: "prepared", document: prepared.document };
    base.range = prepared.range;
  }
  const next = { ...base, ...input.text, operationId };
  const signed = TextInputSchema.parse({
    ...next,
    inputFingerprint: textFingerprint(next, hashString),
  });
  return { id: source.id, kind: "text" as const, required: true, task: signed };
}

/** The label core of the full page, for exactly this owner, page and policy. */
async function labelCore(
  input: LabelPlanInput,
  fullDocument: ArtifactRef,
  core: { reader?: LabelCoreReader | undefined; signal: AbortSignal },
) {
  if (!core.reader) {
    throw labelFailure("CHANNEL.CORE_UNAVAILABLE");
  }
  const request = { owner: input.owner, fullDocument };
  const prepared = LabelCoreOutcomeSchema.parse(await core.reader.inspect(request, core.signal));
  const own =
    isDeepStrictEqual(prepared.input, request) &&
    prepared.document.producer.implementationVersion === input.corePolicy;
  if (!own) {
    throw labelFailure("CHANNEL.CORE_IDENTITY_CONFLICT");
  }
  return prepared;
}

function labelImageTask(
  input: LabelPlanInput,
  prepared: { source: SavedEvidenceSource; resolved: ImageSource; operationId: string },
) {
  const { source, resolved, operationId } = prepared;
  const { selection } = resolved.task.input;
  const own =
    source.kind === "file-image" &&
    resolved.task.input.operationId === source.visionOperationId &&
    selection.ocrOperationId === source.plan.ocrOperationId &&
    selection.image.artifactId === source.plan.imageId &&
    selection.status === "matched";
  if (!own) {
    throw conflict();
  }
  const vision = { operationId, extractionProtocol: "label-extraction/1" as const, selection };
  const task = { configFingerprint: input.visionConfigFingerprint, input: vision };
  return { id: source.id, kind: "image" as const, required: true, task };
}
