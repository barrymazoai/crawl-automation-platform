import { errorCodeOf, measuredCall, type ObjectStore } from "@crawl-automation/platform";
import type { LabelImageCandidate, VisionTask } from "@crawl-automation/v3-contracts";
import { encodeJson } from "../results/result-record.js";
import { writeOnce } from "../results/write-once.js";
import { retentionSignal } from "../step/retention.js";
import type { VisionModel } from "./codex-vision-model.js";
import {
  canRepairLabel,
  decodeLabelVisionRepair,
  labelVisionRepairPolicyVersion,
  repairFindings,
  type RepairFinding,
} from "./protocol/label-vision-repair.js";
import { visionFailure } from "./vision-errors.js";
import { visionKeys, visionResponse } from "./vision-files.js";

interface RepairInput {
  task: VisionTask;
  image: Uint8Array;
  model: Pick<VisionModel, "repair" | "repairEnabled" | "repairFingerprint">;
  local: ObjectStore;
  remote: ObjectStore;
  originalRaw: string;
  candidate: LabelImageCandidate;
  codes: string[];
  signal: AbortSignal;
}

/** One bounded repair turn after a valid original answer; a failed repair retains the original Review. */
export async function attemptVisionRepair(input: RepairInput): Promise<{
  raw: string;
  repairCodes: string[];
} | null> {
  const { model, candidate, codes } = input;
  const findings = repairFindings(candidate, codes);
  if (!canRepairLabel(codes, findings) || model.repairEnabled === false || !model.repair) {
    return null;
  }
  await retainOriginal(input);
  const { repairRaw, repairCodes } = await askRepair(input, findings, model.repair.bind(model));
  return {
    raw: JSON.stringify({
      codec: labelVisionRepairPolicyVersion,
      operationId: `${input.task.input.operationId}:repair`,
      fingerprint: model.repairFingerprint ?? "0".repeat(64),
      originalRaw: input.originalRaw,
      originalCandidate: candidate,
      originalCodes: codes,
      findings,
      repairRaw,
      repairCodes,
    }),
    repairCodes,
  };
}

async function askRepair(
  input: RepairInput,
  findings: RepairFinding[],
  repair: NonNullable<VisionModel["repair"]>,
) {
  const { task, image, candidate, codes, signal } = input;
  let repairRaw: string | null = null;
  let repairCodes: string[] = [];
  try {
    repairRaw = await measuredCall(
      {
        kind: "model-image",
        step: "label-vision-repair",
        providerCall: true,
        cacheHit: false,
        operationId: `${task.input.operationId}:repair`,
      },
      () =>
        repair(
          {
            image: task.input.selection.image,
            bytes: image,
            original: structuredClone(candidate),
            findings,
          },
          signal,
        ),
    );
    repairCodes = decodeLabelVisionRepair(
      repairRaw,
      candidate,
      codes.includes("LABEL.INGREDIENT_BOUNDARY"),
    ).codes;
  } catch (error) {
    repairCodes = [errorCodeOf(error) ?? "VISION.UNRESOLVED"];
  }
  return { repairRaw, repairCodes };
}

/** The first model answer is durable before a second paid turn can start. */
async function retainOriginal(input: RepairInput): Promise<void> {
  const { task, originalRaw, local, remote, signal } = input;
  const entry = {
    key: visionKeys.repairOriginal(task),
    bytes: encodeJson(visionResponse(task, originalRaw)),
  };
  await writeOnce(local, entry, {
    signal: retentionSignal(),
    mismatch: () => visionFailure("VISION.LOCAL_EVIDENCE_CONFLICT", "executed"),
  });
  await writeOnce(remote, entry, {
    signal,
    mismatch: () => visionFailure("VISION.HANDOFF_PENDING", "executed"),
  });
}
