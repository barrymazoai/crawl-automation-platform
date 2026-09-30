import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { errorCodeOf, isAppError, type ObjectStore } from "@crawl-automation/platform";
import { CodexError } from "@crawl-automation/platform";
import { codexDetailOf, codexFactOf } from "../codex/codex-errors.js";
import type { VisionTask } from "@crawl-automation/v3-contracts";
import { decodeJson, encodeJson } from "../results/result-record.js";
import { writeOnce } from "../results/write-once.js";
import { claimIntent, type IntentFailure } from "../step/intent-claim.js";
import { recordedFact } from "../step/step-failure.js";
import {
  isVisionErrorCode,
  visionErrors,
  visionFailure,
  type VisionErrorCode,
} from "./vision-errors.js";
import {
  VisionFailureFileSchema,
  VisionIntentSchema,
  visionKeys,
  visionLimits,
  visionTaskFingerprint,
} from "./vision-files.js";
import { retentionSignal } from "../step/retention.js";

type VisionIntent = z.infer<typeof VisionIntentSchema>;

const intentCodes: Record<IntentFailure, VisionErrorCode> = {
  intentUnknown: "VISION.INTENT_UNVERIFIED",
  intentConflict: "VISION.INPUT_CONFLICT",
  executionUnknown: "VISION.EXECUTION_UNKNOWN",
};

/**
 * Claims the only right to call the model for this task: a create-once intent in R2. When an intent already exists,
 * the model may already have run, so the earlier attempt's facts are reported instead; nothing is called again.
 */
export async function claimVisionIntent(
  stores: { local: ObjectStore; remote: ObjectStore },
  task: VisionTask,
  signal: AbortSignal,
): Promise<void> {
  const key = visionKeys.intent(task);
  const existing = await stores.remote.read(key, visionLimits.intentBytes, signal);
  if (existing) {
    throw await earlierAttempt(stores, { task, intent: existing }, signal);
  }
  const intent: VisionIntent = {
    fingerprint: visionTaskFingerprint(task),
    nonce: randomUUID(),
    input: task.input,
  };
  return claimIntent<VisionIntent, VisionIntent>(
    {
      store: stores.remote,
      key,
      intent,
      parse: (raw) => VisionIntentSchema.parse(raw),
      limit: visionLimits.intentBytes,
      sameTask: sameVisionTask,
      fail: (reason, cause) => visionFailure(intentCodes[reason], "unknown", cause),
    },
    signal,
  );
}

/** Whether two intents are the same task: the same input on the same vision setup. */
function sameVisionTask(
  saved: { fingerprint: string; input: unknown },
  proposed: { fingerprint: string; input: unknown },
): boolean {
  return (
    saved.fingerprint === proposed.fingerprint && isDeepStrictEqual(saved.input, proposed.input)
  );
}

/** What an earlier attempt left: another task's intent, a kept answer, a recorded failure, or nothing known. */
async function earlierAttempt(
  stores: { local: ObjectStore; remote: ObjectStore },
  earlier: { task: VisionTask; intent: Uint8Array },
  signal: AbortSignal,
) {
  const { task } = earlier;
  const intent = VisionIntentSchema.safeParse(readableJson(earlier.intent));
  const fingerprint = visionTaskFingerprint(task);
  if (!intent.success || !sameVisionTask(intent.data, { fingerprint, input: task.input })) {
    return visionFailure("VISION.INPUT_CONFLICT");
  }
  const response = visionKeys.response(task);
  const answered =
    (await stores.remote.read(response, visionLimits.responseBytes, signal)) ??
    (await stores.local.read(response, visionLimits.responseBytes, signal));
  if (answered) {
    return visionFailure("VISION.HANDOFF_PENDING", "executed");
  }
  const failure = await stores.local.read(
    visionKeys.failure(task),
    visionLimits.failureBytes,
    signal,
  );
  return failure
    ? recordedFailure(failure, fingerprint)
    : visionFailure("VISION.EXECUTION_UNKNOWN");
}

/** The failure an earlier call recorded, with its own code, fact and Codex's words. */
function recordedFailure(bytes: Uint8Array, fingerprint: string) {
  const parsed = VisionFailureFileSchema.safeParse(readableJson(bytes));
  if (!parsed.success || parsed.data.fingerprint !== fingerprint) {
    return visionFailure("VISION.INPUT_CONFLICT");
  }
  const { code, executionFact, detail } = parsed.data;
  if (!isVisionErrorCode(code)) {
    // A Codex failure (`VISION.CODEX_*`), replayed with its own code, fact and words.
    return new CodexError(code, executionFact, detail);
  }
  return visionErrors.create(code, {
    details: { executionFact, ...(detail ? { cause: detail } : {}) },
  });
}

/**
 * Keeps a failed call's facts locally, so a redelivery reports the same failure instead of guessing. Keeping them is
 * best effort: the failure itself is recorded as a Review either way.
 */
export async function keepCallFailure(
  local: ObjectStore,
  task: VisionTask,
  error: unknown,
): Promise<void> {
  const code = errorCodeOf(error);
  const failure = {
    fingerprint: visionTaskFingerprint(task),
    code: code?.startsWith("VISION.") ? code : "VISION.EXECUTION_UNKNOWN",
    executionFact:
      codexFactOf(error) ?? (isAppError(error) ? recordedFact(error) : null) ?? "unknown",
    ...causeOf(error),
  };
  const entry = {
    key: visionKeys.failure(task),
    bytes: encodeJson(VisionFailureFileSchema.parse(failure)),
  };
  const signal = retentionSignal();
  try {
    await writeOnce(local, entry, {
      signal,
      mismatch: () => visionFailure("VISION.LOCAL_EVIDENCE_CONFLICT"),
    });
  } catch {
    // The call's own failure is what the step reports; these facts only help a later redelivery.
  }
}

function causeOf(error: unknown): { detail?: string } {
  const cause = codexDetailOf(error) ?? (isAppError(error) ? error.details["cause"] : undefined);
  return typeof cause === "string" && cause ? { detail: cause.slice(0, 600) } : {};
}

/** Stored JSON, or undefined when it cannot be read (the schema check then rejects it). */
function readableJson(bytes: Uint8Array): unknown {
  try {
    return decodeJson(bytes);
  } catch {
    return undefined;
  }
}
