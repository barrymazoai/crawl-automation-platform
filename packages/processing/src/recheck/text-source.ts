import { z } from "zod";
import {
  TextCandidateV3Schema,
  TextOutputSchema,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import { decodeJson } from "../results/result-record.js";
import { isOwnOutput, parseTextTask, textKeys } from "../text/results/text-record.js";
import { textResultKind } from "../text/results/text-kind.js";
import { labelReviewFailure } from "../text/protocol/text-protocol.js";
import { recheckTextAnswer } from "./decode-text.js";
import { derivedText } from "./derived-records.js";
import { recheckErrors } from "./errors.js";
import { RecheckPreparation } from "./preparation.js";
import { assertRecheckIdentity, RecheckFiles, recheckDigest } from "./verified-files.js";
import type { RecheckedSource, RecheckSource, SavedAnswerDeps, SourceReceipt } from "./types.js";

type Source = Extract<RecheckSource, { kind: "text" }>;
const RawAnswer = z.object({ rawResponse: z.string().min(1).max(250_000) });

export class RecheckTextSource {
  private readonly files: RecheckFiles;
  constructor(private readonly deps: SavedAnswerDeps) {
    this.files = new RecheckFiles(deps.objects);
  }

  async read(
    source: Source,
    review: ReviewRecord | null,
    signal: AbortSignal,
  ): Promise<RecheckedSource> {
    const input = parseTextTask(source.task);
    const fullText = await new RecheckPreparation(this.deps).text(input, signal);
    const saved = review
      ? await this.reviewAnswer(source, review, signal)
      : await this.registered(source, signal);
    const decoded = recheckTextAnswer(input, fullText, saved.rawResponse);
    if (decoded.status === "review") {
      return {
        receipt: saved.receipt,
        files: [],
        failure: {
          id: source.id,
          code: labelReviewFailure(decoded.codes[0] ?? "LABEL.EXTRACTION_INCOMPLETE").code,
          verifiedExecuted: true,
          hasFormula: !!decoded.candidate.formula,
        },
      };
    }
    const candidate = TextCandidateV3Schema.parse({ ...decoded.candidate, schemaVersion: 3 });
    const derived = derivedText(source, { ...saved, candidate, storageId: this.deps.storageId });
    return {
      receipt: saved.receipt,
      files: derived.files,
      entry: { id: source.id, kind: "text", record: derived.record, candidate, fullText },
    };
  }

  private async reviewAnswer(source: Source, review: ReviewRecord, signal: AbortSignal) {
    if (
      !review.candidate ||
      !["text-raw-response/1", "text-output/1"].includes(review.candidate.schema)
    ) {
      throw recheckErrors.create("RECHECK.EVIDENCE_UNAVAILABLE");
    }
    assertRecheckIdentity(review.failure.evidenceKey, textKeys.intent(source.task));
    const intent = z
      .object({ input: z.unknown() })
      .parse(await this.files.json(review.failure.evidenceKey, signal));
    assertRecheckIdentity(parseTextTask(intent.input), source.task);
    const receipt: SourceReceipt = {
      sourceId: source.id,
      kind: "registered-review",
      receiptId: review.reviewId,
      sha256: recheckDigest(review),
    };
    return { ...RawAnswer.parse(review.candidate.value), receipt };
  }

  private async registered(source: Source, signal: AbortSignal) {
    const record = await this.deps.textRecords.read(source.task.operationId);
    if (!record) {
      throw recheckErrors.create("RECHECK.RECEIPT_UNVERIFIED");
    }
    assertRecheckIdentity(record.input, source.task);
    const output = TextOutputSchema.parse(
      decodeJson(await this.files.artifact(record.result, source.task, signal)),
    );
    const completion = decodeJson(
      await this.files.artifact(record.completion, source.task, signal),
    );
    assertRecheckIdentity(
      completion,
      textResultKind(this.deps.text).manifest(source.task, record.result),
    );
    if (!isOwnOutput(source.task, output)) {
      throw recheckErrors.create("RECHECK.IDENTITY_CONFLICT");
    }
    const receipt: SourceReceipt = {
      sourceId: source.id,
      kind: "registered-result",
      receiptId: source.task.operationId,
      sha256: recheckDigest(record),
    };
    return { rawResponse: output.rawResponse, receipt };
  }
}
