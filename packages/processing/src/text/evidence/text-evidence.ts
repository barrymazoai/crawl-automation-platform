import {
  OcrOutputSchema,
  TextDocumentSchema,
  assertProcessingResultMatches,
  textObservation,
  type ArtifactRef,
  type TextInput,
} from "@crawl-automation/v3-contracts";
import type { ArtifactResolver } from "@crawl-automation/v3-artifacts";
import type { OcrResultHandoff } from "@crawl-automation/v3-results";
import { isAppError } from "@crawl-automation/platform";
import { textFailure } from "../errors.js";
import { splitsCharacter } from "../protocol/text-range.js";
import type { LabelCorePolicies } from "./label-core-policy.js";
import { textLimits } from "../limits.js";

export interface SourceText {
  text: string;
  /** Every artifact the text depends on; each must be durable before the result counts. */
  refs: ArtifactRef[];
}

export interface TextEvidenceDeps {
  artifacts: Pick<ArtifactResolver, "resolve">;
  ocr: Pick<OcrResultHandoff, "inspect">;
  /** Cloud mode only: a worker without a ledger verifies OCR-sourced text against the remote bytes. */
  remoteOcr?: Pick<OcrResultHandoff, "inspectRemote">;
  labelCores: LabelCorePolicies;
}

const utf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const conflict = () => textFailure("TEXT.SOURCE_CONFLICT", "not_executed");

/** The text a task reads: an OCR result, or a prepared text document, each verified against its evidence. */
export class TextEvidence {
  constructor(private readonly deps: TextEvidenceDeps) {}

  async resolve(input: TextInput, signal: AbortSignal): Promise<SourceText> {
    try {
      const source =
        input.source.kind === "ocr"
          ? await this.fromOcr(input, signal)
          : await this.fromDocument(input, signal);
      assertRange(source.text, input);
      return source;
    } catch (error) {
      if (isAppError(error) && error.code.startsWith("TEXT.")) {
        throw error;
      }
      throw textFailure("TEXT.EVIDENCE_UNAVAILABLE", "not_executed", error);
    }
  }

  private async fromOcr(input: TextInput, signal: AbortSignal): Promise<SourceText> {
    if (input.source.kind !== "ocr") {
      throw conflict();
    }
    const expected = input.source.registration;
    let facts = await this.deps.ocr.inspect(expected.input, signal);
    if (!facts.record && this.deps.remoteOcr) {
      facts = await this.deps.remoteOcr.inspectRemote(expected.input, signal);
    }
    // The registration embedded in the task came from the receipt, so durable and identical evidence suffices.
    const sameRecord = JSON.stringify(facts.record) === JSON.stringify(expected);
    if (
      !facts.artifactDurable ||
      !sameRecord ||
      (!facts.resultRegistered && !this.deps.remoteOcr)
    ) {
      throw textFailure("TEXT.UPSTREAM_UNVERIFIED", "not_executed");
    }
    const result = await this.deps.artifacts.resolve(
      expected.result,
      textObservation(input),
      signal,
    );
    const output = OcrOutputSchema.parse(JSON.parse(utf8(result.bytes)));
    assertProcessingResultMatches(expected.input, output, "output");
    return { text: output.text, refs: [expected.input.file, expected.result, expected.completion] };
  }

  private async fromDocument(input: TextInput, signal: AbortSignal): Promise<SourceText> {
    if (input.source.kind === "ocr") {
      throw conflict();
    }
    const owner = textObservation(input);
    const ref = input.source.document;
    const bytes = (await this.deps.artifacts.resolve(ref, owner, signal)).bytes;
    const document = TextDocumentSchema.parse(JSON.parse(utf8(bytes)));
    const sameOwner = JSON.stringify(textObservation(document)) === JSON.stringify(owner);
    if (!sameOwner || document.producer !== ref.producer.module) {
      throw conflict();
    }
    const original = await this.deps.artifacts.resolve(document.source, owner, signal);
    if (document.producer === "label.core.prepare") {
      this.assertLabelCore({ document, ref, originalHtml: utf8(original.bytes) });
    }
    return { text: document.text, refs: [ref, document.source] };
  }

  /** The label facts text must be exactly what its policy reads from the source page. */
  private assertLabelCore(core: {
    document: ReturnType<typeof TextDocumentSchema.parse>;
    ref: ArtifactRef;
    originalHtml: string;
  }): void {
    const { document, ref } = core;
    const policy = document.corePolicy ? this.deps.labelCores[document.corePolicy] : undefined;
    if (
      !policy ||
      document.source.producer.module !== policy.sourceModule ||
      ref.producer.implementationVersion !== document.corePolicy ||
      (policy.sourceVersion !== undefined &&
        document.source.producer.implementationVersion !== policy.sourceVersion) ||
      document.text !== policy.extract(core.originalHtml)
    ) {
      throw conflict();
    }
  }
}

function assertRange(text: string, input: TextInput): void {
  const { start, end } = input.range;
  const empty = !text.slice(start, end).trim();
  if (
    text.length > textLimits.sourceTextLength ||
    end > text.length ||
    empty ||
    splitsCharacter(text, input.range)
  ) {
    throw textFailure("TEXT.RANGE_INVALID", "not_executed");
  }
}
