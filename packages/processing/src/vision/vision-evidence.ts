import { isDeepStrictEqual } from "node:util";
import { verifyBytes } from "@crawl-automation/platform";
import type { ObjectStore } from "@crawl-automation/platform";
import type { VisionTask } from "@crawl-automation/v3-contracts";
import { decodeJson, hashString } from "../results/result-record.js";
import { decodeVisionResult } from "./protocol/vision-protocol.js";
import { visionFailure } from "./vision-errors.js";
import {
  VisionIntentSchema,
  VisionResponseSchema,
  visionKeys,
  visionLimits,
  visionTaskFingerprint,
} from "./vision-files.js";

export interface VisionEvidenceDeps {
  local: ObjectStore;
  remote: ObjectStore;
  /** Re-verifies the OCR text the keyword selection was made from; throws when it does not hold. */
  verifyOcr(task: VisionTask, signal: AbortSignal): Promise<void>;
}

export interface VerifiedAnswer {
  bytes: Uint8Array;
  status: "candidate" | "partial";
  candidate: unknown;
  /** Whether the answer is in R2 (otherwise only kept locally). */
  inR2: boolean;
}

/**
 * The evidence a vision result stands on, checked in full: the OCR selection, the image in R2, the intent and the
 * stored answer, all belonging to this task, and an answer that decodes to an accepted result.
 */
export class VisionEvidence {
  constructor(private readonly deps: VisionEvidenceDeps) {}

  async verify(
    task: VisionTask,
    options: { allowLocal: boolean },
    signal: AbortSignal,
  ): Promise<VerifiedAnswer> {
    await this.deps.verifyOcr(task, signal);
    await this.assertImageDurable(task, signal);
    const intent = await this.deps.remote.read(
      visionKeys.intent(task),
      visionLimits.intentBytes,
      signal,
    );
    const answer = await this.storedAnswer(task, options, signal);
    if (!intent || !answer) {
      throw visionFailure("VISION.HANDOFF_INCOMPLETE", "executed");
    }
    const raw = this.assertOwnAnswer(task, { intent, answer: answer.bytes });
    const decoded = decodeAnswer(task, raw);
    if (decoded.status === "review") {
      throw visionFailure("VISION.RESULT_NOT_ACCEPTED", "executed");
    }
    return { ...answer, status: decoded.status, candidate: decoded.candidate };
  }

  private async assertImageDurable(task: VisionTask, signal: AbortSignal): Promise<void> {
    const image = task.input.selection.image;
    const bytes = await this.deps.remote.read(image.objectKey, visionLimits.imageBytes, signal);
    if (!bytes) {
      throw visionFailure("VISION.SOURCE_NOT_DURABLE");
    }
    try {
      verifyBytes(image, bytes, visionLimits.imageBytes);
    } catch (error) {
      throw visionFailure("VISION.RESULT_INTEGRITY", "unknown", error);
    }
  }

  private async storedAnswer(
    task: VisionTask,
    options: { allowLocal: boolean },
    signal: AbortSignal,
  ) {
    const key = visionKeys.response(task);
    const inR2 = await this.deps.remote.read(key, visionLimits.responseBytes, signal);
    if (inR2) {
      return { bytes: inR2, inR2: true };
    }
    const kept = options.allowLocal
      ? await this.deps.local.read(key, visionLimits.responseBytes, signal)
      : null;
    return kept ? { bytes: kept, inR2: false } : null;
  }

  /** The intent and the answer name exactly this task, and the answer's hash matches its text. */
  private assertOwnAnswer(
    task: VisionTask,
    stored: { intent: Uint8Array; answer: Uint8Array },
  ): string {
    try {
      const intent = VisionIntentSchema.parse(decodeJson(stored.intent));
      const answer = VisionResponseSchema.parse(decodeJson(stored.answer));
      const fingerprint = visionTaskFingerprint(task);
      const own =
        intent.fingerprint === fingerprint &&
        answer.fingerprint === fingerprint &&
        isDeepStrictEqual(intent.input, task.input) &&
        hashString(answer.raw) === answer.sha256;
      if (own) {
        return answer.raw;
      }
    } catch (error) {
      throw visionFailure("VISION.EVIDENCE_CONFLICT", "executed", error);
    }
    throw visionFailure("VISION.EVIDENCE_CONFLICT", "executed");
  }
}

/** An answer that cannot be read at all is invalid output, whatever the decoder threw. */
export function decodeAnswer(task: VisionTask, raw: string) {
  try {
    return decodeVisionResult(task.input, raw);
  } catch (error) {
    throw visionFailure("VISION.INVALID_OUTPUT", "executed", error);
  }
}
