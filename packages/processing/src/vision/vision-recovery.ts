import {
  LabelImageCandidateSchema,
  VisionCandidateSchema,
  VisionTaskSchema,
  type VisionRecord,
  type VisionTask,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import { encodeJson } from "../results/result-record.js";
import { writeOnce } from "../results/write-once.js";
import { visionFailure } from "./vision-errors.js";
import { prepareVisionRecord, visionKeys, visionLimits } from "./vision-files.js";
import type { VisionFacts, VisionResults, VisionResultsDeps } from "./vision-results.js";
import { readReviewedLabelImage } from "./reviewed-label-image.js";

/**
 * Reading and finishing vision results: registering what a cloud worker left in R2, reading an accepted candidate for
 * the label steps, and recovering an answer kept only locally. Never calls the model and never registers twice.
 */
export class VisionRecovery {
  constructor(
    private readonly results: VisionResults,
    private readonly deps: VisionResultsDeps & { settleRemote?: boolean },
  ) {}

  /** Registers what a cloud worker left in R2, after rebuilding the record and checking every byte of it. */
  async registerFromRemote(raw: unknown, signal: AbortSignal): Promise<VisionFacts> {
    const task = VisionTaskSchema.parse(raw);
    const before = await this.results.inspect(task, signal);
    if (before.resultRegistered) {
      return before;
    }
    if (!this.deps.registry) {
      throw visionFailure("VISION.REGISTRY_UNAVAILABLE", "executed");
    }
    const answer = await this.deps.evidence.verify(task, { allowLocal: false }, signal);
    const prepared = prepareVisionRecord(task, answer, this.deps.storageId);
    const key = prepared.record.completion.objectKey;
    const completion = await this.deps.remote.read(key, visionLimits.completionBytes, signal);
    if (!completion) {
      throw visionFailure("VISION.RESULT_NOT_DURABLE", "executed");
    }
    if (!prepared.completion.equals(Buffer.from(completion))) {
      throw visionFailure("VISION.RESULT_INTEGRITY", "executed");
    }
    if (!before.record) {
      await this.keep(
        { key: visionKeys.registration(task), bytes: encodeJson(prepared.record) },
        signal,
      );
    }
    return this.results.register(task, signal);
  }

  /** The accepted candidate of a registered result in the old vision-candidate/1 format. */
  async readCandidate(raw: unknown, signal: AbortSignal) {
    const task = VisionTaskSchema.parse(raw);
    if (task.input.extractionProtocol) {
      throw visionFailure("VISION.LEGACY_PROTOCOL_UNSUPPORTED");
    }
    const { record, candidate } = await this.registeredCandidate(task, signal);
    return { record, candidate: VisionCandidateSchema.parse(candidate) };
  }

  /** The accepted candidate of a registered result in a label format. */
  async readLabelCandidate(raw: unknown, signal: AbortSignal) {
    const task = VisionTaskSchema.parse(raw);
    if (!task.input.extractionProtocol) {
      throw visionFailure("VISION.LABEL_PROTOCOL_REQUIRED");
    }
    const { record, candidate } = await this.registeredCandidate(task, signal);
    return { record, candidate: LabelImageCandidateSchema.parse(candidate) };
  }

  /** Read-only partial evidence; the original failed operation remains a Review. */
  readReviewedLabel(at: { task: VisionTask; review: ReviewRecord }, signal: AbortSignal) {
    return readReviewedLabelImage(this.deps.evidence, at, signal);
  }

  /** What a recovery would find: a registered result, or an answer kept locally or in R2. */
  async inspectRecovery(raw: unknown, signal: AbortSignal) {
    const task = VisionTaskSchema.parse(raw);
    const facts = await this.results.inspect(task, signal);
    if (facts.resultRegistered) {
      return { computed: true, durable: true, registered: true };
    }
    const answer = await this.deps.evidence.verify(task, { allowLocal: true }, signal);
    return { computed: true, durable: answer.inR2, registered: false };
  }

  /** Uploads an answer kept only locally; it is checked in full first. */
  async uploadRecovered(raw: unknown, signal: AbortSignal): Promise<void> {
    const task = VisionTaskSchema.parse(raw);
    const answer = await this.deps.evidence.verify(task, { allowLocal: true }, signal);
    if (!answer.inR2) {
      const entry = { key: visionKeys.response(task), bytes: answer.bytes };
      await writeOnce(this.deps.remote, entry, {
        signal,
        mismatch: () => visionFailure("VISION.HANDOFF_UNKNOWN"),
      });
    }
  }

  private async registeredCandidate(task: VisionTask, signal: AbortSignal) {
    let facts = await this.results.inspect(task, signal);
    if (!facts.resultRegistered && this.deps.settleRemote && this.deps.registry) {
      facts = await this.registerFromRemote(task, signal);
    }
    const record: VisionRecord | null = facts.resultRegistered ? facts.record : null;
    if (!record) {
      throw visionFailure("VISION.RESULT_NOT_REGISTERED");
    }
    const answer = await this.deps.evidence.verify(task, { allowLocal: false }, signal);
    return { record, candidate: answer.candidate };
  }

  private keep(entry: { key: string; bytes: Uint8Array }, signal: AbortSignal) {
    return writeOnce(this.deps.local, entry, {
      signal,
      mismatch: () => visionFailure("VISION.HANDOFF_UNKNOWN", "executed"),
    });
  }
}
