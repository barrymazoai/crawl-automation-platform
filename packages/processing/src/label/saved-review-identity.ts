import { isDeepStrictEqual } from "node:util";
import type { ReviewRecord, SavedEvidenceSource } from "@crawl-automation/v3-contracts";
import { keywordCompatibility } from "../keywords/keyword-screening.js";
import { hashString } from "../results/result-record.js";
import { labelFailure } from "./label-errors.js";
import type { SavedSourceTasks } from "./saved-source-tasks.js";

type Reviewable = Exclude<SavedEvidenceSource, { kind: "file-image" }>;
type Of<Kind extends Reviewable["kind"]> = Extract<Reviewable, { kind: Kind }>;
interface Operation {
  operationId: string;
  inputFingerprint: string;
}
interface Lookup {
  review: ReviewRecord;
  tasks: SavedSourceTasks;
  signal: AbortSignal;
}

const conflict = () => labelFailure("SAVED.IDENTITY_CONFLICT");
const TEXT_STAGES = ["codex.text", "text.receipt"];

/** The operation a source's Review must name, for the stage it stopped at; an unknown stage is a conflict. */
export function reviewedOperation(source: Reviewable, lookup: Lookup): Promise<Operation> {
  if (source.kind === "pdf-text") {
    return pdfOperation(source, lookup);
  }
  if (source.kind === "page") {
    return pageOperation(source, lookup);
  }
  return imageOperation(source, lookup);
}

async function pdfOperation(source: Of<"pdf-text">, lookup: Lookup): Promise<Operation> {
  const { stage } = lookup.review.failure;
  if (stage === "pdf.text" || stage === "pdf.text-input") {
    const details = lookup.review.rawError.details;
    const planned =
      stage === "pdf.text" ||
      (typeof details === "object" &&
        details !== null &&
        !Array.isArray(details) &&
        isDeepStrictEqual((details as { plan?: unknown }).plan, source.plan));
    if (!planned) {
      throw conflict();
    }
    return source.plan.extraction;
  }
  if (TEXT_STAGES.includes(stage)) {
    return (await lookup.tasks.pdf(source, lookup.signal)).task;
  }
  throw conflict();
}

async function pageOperation(source: Of<"page">, lookup: Lookup): Promise<Operation> {
  const { stage } = lookup.review.failure;
  if (stage === "page.prepare" || stage === "page.text-input") {
    return source.plan.page;
  }
  if (TEXT_STAGES.includes(stage)) {
    return (await lookup.tasks.page(source, lookup.signal)).task;
  }
  throw conflict();
}

async function imageOperation(source: Of<"ocr-image">, lookup: Lookup): Promise<Operation> {
  const { stage } = lookup.review.failure;
  if (stage === "ocr.file" || stage === "ocr.receipt") {
    return source.task;
  }
  if (stage === "ocr.keywords") {
    const registration = await lookup.tasks.registration(source);
    return {
      operationId: `screen-${hashString(JSON.stringify([source.task.operationId, keywordCompatibility]))}`,
      inputFingerprint: hashString(JSON.stringify(registration)),
    };
  }
  if (stage === "codex.vision") {
    const resolved = await lookup.tasks.image(source, lookup.signal);
    const inputFingerprint = lookup.tasks.deps.visionFingerprint(resolved.task);
    return { operationId: source.visionOperationId, inputFingerprint };
  }
  throw conflict();
}
