import {
  LabelImageCandidateSchema,
  assessLabelCandidate,
  labelImageIntegrityCodes,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import { decodeJson, hashString } from "../results/result-record.js";
import { decodeVisionResult } from "../vision/protocol/vision-protocol.js";
import { isVisionErrorCode, visionErrors } from "../vision/vision-errors.js";
import {
  VisionIntentSchema,
  VisionResponseSchema,
  visionKeys,
  visionTaskFingerprint,
  prepareVisionRecord,
} from "../vision/vision-files.js";
import { derivedImage } from "./derived-records.js";
import { recheckErrors } from "./errors.js";
import { assertRecheckIdentity, RecheckFiles, recheckDigest } from "./verified-files.js";
import type { RecheckedSource, RecheckSource, SavedAnswerDeps, SourceReceipt } from "./types.js";

type Source = Extract<RecheckSource, { kind: "image" }>;
export class RecheckImageSource {
  private readonly files: RecheckFiles;
  constructor(private readonly deps: SavedAnswerDeps) {
    this.files = new RecheckFiles(deps.objects);
  }

  async read(
    source: Source,
    review: ReviewRecord | null,
    signal: AbortSignal,
  ): Promise<RecheckedSource> {
    await this.prepare(source, signal);
    const saved = review
      ? await this.reviewAnswer(source, review, signal)
      : await this.registered(source, signal);
    const assessment = assessLabelCandidate(saved.candidate);
    const codes = [...assessment.codes, ...labelImageIntegrityCodes(saved.candidate)];
    if (codes.length || saved.code) {
      return {
        receipt: saved.receipt,
        files: [],
        failure: {
          id: source.id,
          code: checkedVisionCode(
            saved.code ??
              (codes[0] ?? "LABEL.EXTRACTION_INCOMPLETE").replace("LABEL.", "VISION.LABEL_"),
          ),
          verifiedExecuted: true,
          candidate: saved.candidate,
        },
      };
    }
    const status = assessment.status === "partial" ? "partial" : "candidate";
    const derived = derivedImage(source, { ...saved, status, storageId: this.deps.storageId });
    return {
      receipt: saved.receipt,
      files: derived.files,
      entry: { id: source.id, kind: "image", record: derived.record, candidate: saved.candidate },
    };
  }

  private async prepare(source: Source, signal: AbortSignal) {
    const { task } = source;
    await this.deps.verifyOcr(task, signal);
    await this.files.artifact(task.input.selection.image, task.input.selection.observation, signal);
    const intent = VisionIntentSchema.parse(await this.files.json(visionKeys.intent(task), signal));
    assertRecheckIdentity(intent.input, task.input);
    assertRecheckIdentity(intent.fingerprint, visionTaskFingerprint(task));
  }

  private async reviewAnswer(source: Source, review: ReviewRecord, signal: AbortSignal) {
    if (review.candidate?.schema !== "label-extraction/1") {
      throw recheckErrors.create("RECHECK.EVIDENCE_UNAVAILABLE");
    }
    assertRecheckIdentity(review.failure.evidenceKey, visionKeys.response(source.task));
    const answer = this.decode(source, await this.files.json(review.failure.evidenceKey, signal));
    assertRecheckIdentity(
      answer.candidate,
      LabelImageCandidateSchema.parse(review.candidate.value),
    );
    const receipt: SourceReceipt = {
      sourceId: source.id,
      kind: "registered-review",
      receiptId: review.reviewId,
      sha256: recheckDigest(review),
    };
    return { ...answer, receipt };
  }

  private async registered(source: Source, signal: AbortSignal) {
    const { task } = source;
    const record = await this.deps.imageRecords.read(task.input.operationId);
    if (!record) {
      throw recheckErrors.create("RECHECK.RECEIPT_UNVERIFIED");
    }
    assertRecheckIdentity(
      { input: record.input, configFingerprint: record.configFingerprint },
      task,
    );
    const owner = task.input.selection.observation;
    const bytes = await this.files.artifact(record.result, owner, signal);
    const answer = this.decode(source, decodeJson(bytes));
    const completion = await this.files.artifact(record.completion, owner, signal);
    const expected = prepareVisionRecord(task, { bytes, status: record.status }, record.storageId);
    assertRecheckIdentity(record, expected.record);
    assertRecheckIdentity(decodeJson(completion), decodeJson(expected.completion));
    const receipt: SourceReceipt = {
      sourceId: source.id,
      kind: "registered-result",
      receiptId: task.input.operationId,
      sha256: recheckDigest(record),
    };
    return { ...answer, receipt };
  }

  private decode(source: Source, raw: unknown) {
    const answer = VisionResponseSchema.parse(raw);
    assertRecheckIdentity(answer.fingerprint, visionTaskFingerprint(source.task));
    assertRecheckIdentity(answer.sha256, hashString(answer.raw));
    const decoded = decodeVisionResult(source.task.input, answer.raw);
    return {
      candidate: LabelImageCandidateSchema.parse(decoded.candidate),
      code: decoded.code,
      rawResponse: answer.raw,
    };
  }
}

function checkedVisionCode(code: string): string {
  return visionErrors.code(isVisionErrorCode(code) ? code : "VISION.INVALID_OUTPUT");
}
