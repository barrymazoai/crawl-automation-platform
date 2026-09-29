import { isDeepStrictEqual } from "node:util";
import type { ObjectStore } from "@crawl-automation/platform";
import { sha256, verifyBytes } from "@crawl-automation/v3-artifacts";
import {
  PdfDataSchema,
  PdfTextPlanSchema,
  PdfTextPrepareInputSchema,
  TextDocumentSchema,
  TextInputSchema,
  observationIdentity,
  textFingerprint,
  type ArtifactRef,
  type PdfCompletion,
  type PdfTextPlan,
  type TextInput,
} from "@crawl-automation/v3-contracts";
import { claimedPublish } from "../publication/claimed-publication.js";
import { decodeJson, encodeJson, hashString } from "../results/result-record.js";
import { writeOnce } from "../results/write-once.js";
import { pdfFailure } from "./pdf-errors.js";
import { PdfEvidence, recordPdfReview, type PdfEvidenceDeps } from "./pdf-evidence.js";
import { checkedPdfInput, pdfCompletionKey } from "./pdf-input.js";
import { assertStepReview } from "./pdf-preparation.js";

const RESULT_LIMIT = 32 * 1024 * 1024;
const DOCUMENT_LIMIT = 2 * 1024 * 1024;
const TASK_LIMIT = 65_536;
const MAX_TEXT_LENGTH = 200_000;

export const pdfTextInputKey = (plan: PdfTextPlan) =>
  `v3/pdf-text-inputs/${plan.textOperationId}/input.json`;

interface TextCandidate {
  plan: PdfTextPlan;
  record: PdfCompletion;
  encoded: Uint8Array;
  ref: ArtifactRef;
  task: TextInput;
}

/** The exact text document and text task a PDF page's extracted text stands for. Read-only. */
export class PdfTextEvidence {
  constructor(
    private readonly remote: Pick<ObjectStore, "read">,
    private readonly evidence: Pick<PdfEvidence, "inspect">,
  ) {}

  async candidate(raw: unknown, signal: AbortSignal): Promise<TextCandidate> {
    const plan = PdfTextPlanSchema.parse(raw);
    const input = plan.extraction;
    if (input.module !== "pdf.text") {
      throw pdfFailure("PDF.IDENTITY_CONFLICT");
    }
    const record = await this.evidence.inspect(input, signal);
    const bytes = record
      ? await this.remote.read(record.artifact.objectKey, record.artifact.byteSize, signal)
      : null;
    if (!record || !bytes) {
      throw pdfFailure("PDF.NOT_DURABLE");
    }
    verifyBytes(record.artifact, bytes, RESULT_LIMIT);
    const data = PdfDataSchema.parse(decodeJson(bytes));
    if (data.kind !== "text" || data.pageIndex !== input.pageIndex) {
      throw pdfFailure("PDF.RESULT_INTEGRITY");
    }
    if (!data.hasText || !data.text.trim()) {
      throw pdfFailure("PDF.TEXT_EMPTY");
    }
    if (data.text.length > MAX_TEXT_LENGTH) {
      throw pdfFailure("PDF.TEXT_LIMIT");
    }
    const document = TextDocumentSchema.parse({
      ...observationIdentity(input),
      producer: "pdf.text",
      source: input.pdf,
      pageIndex: input.pageIndex,
      text: data.text,
    });
    const encoded = encodeJson(document);
    const ref = documentRef(record, encoded);
    return { plan, record, encoded, ref, task: textTask(plan, { ref, length: data.text.length }) };
  }

  /** The text task, once its document and its task record are both durable and exactly as derived. */
  async inspect(plan: PdfTextPlan, signal: AbortSignal): Promise<TextInput> {
    const expected = await this.candidate(plan, signal);
    const document = await this.remote.read(expected.ref.objectKey, DOCUMENT_LIMIT, signal);
    if (!document) {
      throw pdfFailure("PDF.NOT_DURABLE");
    }
    verifyBytes(expected.ref, document, DOCUMENT_LIMIT);
    const stored = await this.remote.read(pdfTextInputKey(plan), TASK_LIMIT, signal);
    const record = {
      schemaVersion: 1,
      plan: expected.plan,
      extraction: expected.record,
      task: expected.task,
    };
    if (!stored || !isDeepStrictEqual(decodeJson(stored), record)) {
      throw pdfFailure("PDF.TEXT_INPUT_UNVERIFIED");
    }
    return expected.task;
  }
}

function documentRef(record: PdfCompletion, encoded: Uint8Array): ArtifactRef {
  const input = record.input;
  return {
    schemaVersion: 1,
    artifactId: `pdf-text-document-${hashString(input.operationId)}`,
    observationId: input.observationId,
    sourceId: input.sourceId,
    listingId: input.listingId,
    variantId: input.variantId,
    kind: "result-json",
    mediaType: "application/json",
    byteSize: encoded.length,
    sha256: sha256(encoded),
    objectKey: `v3/pdf-text-documents/${input.operationId}/document.json`,
    producer: record.artifact.producer,
  };
}

function textTask(plan: PdfTextPlan, document: { ref: ArtifactRef; length: number }): TextInput {
  const unsigned = {
    ...observationIdentity(plan.extraction),
    ...plan.text,
    operationId: plan.textOperationId,
    source: { kind: "prepared" as const, document: document.ref },
    range: { start: 0, end: document.length },
  };
  return TextInputSchema.parse({
    ...unsigned,
    inputFingerprint: textFingerprint(unsigned, hashString),
  });
}

/** Turns a PDF page's extracted text into a text document and its text task, each published once. */
export class PdfTextPreparation {
  private readonly evidence: PdfEvidence;

  constructor(private readonly deps: PdfEvidenceDeps) {
    this.evidence = new PdfEvidence(deps);
  }

  async run(raw: unknown, signal: AbortSignal) {
    const { plan, receipt } = PdfTextPrepareInputSchema.parse(raw);
    const input = plan.extraction;
    try {
      checkedPdfInput(input);
      signal.throwIfAborted();
      if (input.module !== "pdf.text" || (receipt && receipt.operationId !== input.operationId)) {
        throw pdfFailure("PDF.IDENTITY_CONFLICT");
      }
      if (receipt?.status === "review") {
        await assertStepReview(this.deps, { input, receipt, stage: "pdf.text" });
        return receipt;
      }
      const { record, encoded, ref, task } = await new PdfTextEvidence(
        this.deps.remote,
        this.evidence,
      ).candidate(plan, signal);
      if (
        receipt &&
        (receipt.evidenceKey !== pdfCompletionKey(input) ||
          !isDeepStrictEqual(receipt.artifact, record.artifact))
      ) {
        throw pdfFailure("PDF.IDENTITY_CONFLICT");
      }
      await this.publish(ref.objectKey, encoded, signal);
      const evidenceKey = pdfTextInputKey(plan);
      await this.publish(
        evidenceKey,
        encodeJson({ schemaVersion: 1, plan, extraction: record, task }),
        signal,
      );
      return { status: "prepared" as const, task, evidenceKey };
    } catch (error) {
      return recordPdfReview(this.deps, {
        input,
        error,
        preparation: { stage: "pdf.text-input", plan },
      });
    }
  }

  /** Kept locally first, then published behind a one-shot claim that also protects empty-cache replacements. */
  private async publish(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const mismatch = () => pdfFailure("PDF.HANDOFF_UNVERIFIED");
    const pending = () => pdfFailure("PDF.HANDOFF_PENDING");
    const prior = await this.deps.remote.read(key, DOCUMENT_LIMIT, signal);
    if (!prior) {
      await writeOnce(this.deps.journal, { key, bytes }, { signal, mismatch });
    }
    await claimedPublish(
      { local: this.deps.journal, remote: this.deps.remote },
      { key, bytes, limit: DOCUMENT_LIMIT, markerPrefix: "pdf-text-publications" },
      { signal, mismatch, pending, localUnverified: pending },
    );
  }
}
