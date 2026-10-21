import { errorCodeOf, type ObjectStore } from "@crawl-automation/platform";
import { LabelImageCandidateSchema, type VisionTask } from "@crawl-automation/v3-contracts";
import { encodeJson } from "../results/result-record.js";
import { writeOnce } from "../results/write-once.js";
import type { StepAttempt } from "../step/processing-step.js";
import { retentionSignal } from "../step/retention.js";
import type { VisionModel } from "./codex-vision-model.js";
import { MAX_VISION_ANSWER_BYTES } from "./protocol/vision-limits.js";
import { visionCandidateSchema } from "./protocol/vision-protocol.js";
import { decodeAnswer } from "./vision-evidence.js";
import { isVisionErrorCode, visionFailure } from "./vision-errors.js";
import { visionKeys, visionResponse } from "./vision-files.js";
import { attemptVisionRepair } from "./vision-repair-flow.js";

interface AnswerInput {
  task: VisionTask;
  attempt: StepAttempt<VisionTask>;
  image: Uint8Array;
  raw: string;
  model: Pick<VisionModel, "repair" | "repairEnabled" | "repairFingerprint">;
  local: ObjectStore;
  remote: ObjectStore;
  signal: AbortSignal;
}

/** The original answer is judged, optionally repaired once, then the selected evidence is retained. */
export async function finishVisionAnswer(input: AnswerInput) {
  const { task, attempt, raw: originalRaw } = input;
  if (Buffer.byteLength(originalRaw) > MAX_VISION_ANSWER_BYTES) {
    throw visionFailure("VISION.OUTPUT_LIMIT", "executed");
  }
  const original = readAnswer(task, originalRaw);
  setCandidate(attempt, task, original.answer);
  const repair = await repairAnswer(input, original.answer);
  const raw = repair?.raw ?? originalRaw;
  const bytes = encodeJson(visionResponse(task, raw));
  await keepAnswer(input.local, task, bytes);
  const decoded = readAnswer(task, raw);
  setCandidate(attempt, task, decoded.answer);
  await publishAnswer(input, bytes);
  if (!decoded.answer) {
    throw decoded.error;
  }
  if (decoded.answer.status === "review") {
    const code = decoded.answer.code;
    throw visionFailure(
      code && isVisionErrorCode(code) ? code : "VISION.INVALID_OUTPUT",
      "executed",
    );
  }
  return { bytes, status: decoded.answer.status };
}

async function repairAnswer(input: AnswerInput, answer: ReturnType<typeof readAnswer>["answer"]) {
  const candidate = LabelImageCandidateSchema.safeParse(answer?.candidate);
  if (!candidate.success) {
    return null;
  }
  const codes =
    answer && "codes" in answer && Array.isArray(answer.codes) ? (answer.codes as string[]) : [];
  return attemptVisionRepair({
    task: input.task,
    image: input.image,
    model: input.model,
    local: input.local,
    remote: input.remote,
    originalRaw: input.raw,
    candidate: candidate.data,
    codes,
    signal: input.signal,
  });
}

function setCandidate(
  attempt: StepAttempt<VisionTask>,
  task: VisionTask,
  answer: ReturnType<typeof readAnswer>["answer"],
) {
  if (!answer) {
    return;
  }
  attempt.candidate = {
    schema: visionCandidateSchema(task.input.extractionProtocol),
    value: answer.candidate,
  };
  if ("repairCodes" in answer) {
    (attempt as StepAttempt<VisionTask> & { repairCodes?: string[] }).repairCodes =
      answer.repairCodes as string[];
  }
}

function readAnswer(task: VisionTask, raw: string) {
  try {
    return { answer: decodeAnswer(task, raw), error: null };
  } catch (error) {
    return { answer: null, error };
  }
}

function keepAnswer(local: ObjectStore, task: VisionTask, bytes: Uint8Array): Promise<void> {
  const entry = { key: visionKeys.response(task), bytes };
  return writeOnce(local, entry, {
    signal: retentionSignal(),
    mismatch: () => visionFailure("VISION.LOCAL_EVIDENCE_CONFLICT", "executed"),
  });
}

async function publishAnswer(input: AnswerInput, bytes: Uint8Array): Promise<void> {
  const entry = { key: visionKeys.response(input.task), bytes };
  try {
    await writeOnce(input.remote, entry, {
      signal: input.signal,
      mismatch: () => visionFailure("VISION.HANDOFF_PENDING", "executed"),
    });
  } catch (error) {
    const own = errorCodeOf(error)?.startsWith("VISION.");
    throw own ? error : visionFailure("VISION.HANDOFF_PENDING", "executed", error);
  }
}
