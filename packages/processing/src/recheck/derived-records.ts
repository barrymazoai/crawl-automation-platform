import { sha256 } from "@crawl-automation/platform";
import {
  TextRecordSchema,
  VisionRecordSchema,
  textObservation,
  textIdentity,
  type ArtifactRef,
  type LabelImageCandidate,
  type TextCandidateV3,
  type TextInput,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import { encodeJson } from "../results/result-record.js";
import { visionResponse } from "../vision/vision-files.js";
import { recheckDigest } from "./verified-files.js";
import { RECHECK_RULES, type RecheckSource, type SourceReceipt } from "./types.js";

/** Derived receipts live in recovery storage and its ledger, never the original processing_result slot. */
function derivedFiles(source: RecheckSource, at: { output: unknown; receipt: SourceReceipt }) {
  const hash = recheckDigest([RECHECK_RULES, source, at]);
  const key = `v3/rechecks/answers/${hash}`;
  const resultBytes = encodeJson(at.output);
  const result = derivedRef(source, { key: `${key}/result.json`, bytes: resultBytes });
  const completionBytes = encodeJson({
    codec: "retained-answer-receipt/1",
    rules: RECHECK_RULES,
    source,
    original: at.receipt,
    result,
    providerCalled: false,
  });
  const completion = derivedRef(source, { key: `${key}/completion.json`, bytes: completionBytes });
  const files = [
    { key: result.objectKey, bytes: resultBytes },
    { key: completion.objectKey, bytes: completionBytes },
  ];
  return { result, completion, files };
}

function derivedRef(source: RecheckSource, file: { key: string; bytes: Uint8Array }): ArtifactRef {
  const text = source.kind === "text";
  const owner = text ? textObservation(source.task) : source.task.input.selection.observation;
  const producer = text
    ? {
        operationId: source.task.operationId,
        module: source.task.module,
        implementationVersion: source.task.implementationVersion,
      }
    : {
        operationId: source.task.input.operationId,
        module: "codex.vision",
        implementationVersion: "vision/2",
      };
  return {
    schemaVersion: 1,
    artifactId: `rechecked-${recheckDigest(file.key)}`,
    observationId: owner.observationId,
    sourceId: owner.sourceId,
    listingId: owner.listingId,
    variantId: owner.variantId,
    kind: "result-json",
    mediaType: "application/json",
    objectKey: file.key,
    sha256: sha256(file.bytes),
    byteSize: file.bytes.length,
    producer,
  };
}

export function derivedText(
  source: Extract<RecheckSource, { kind: "text" }>,
  at: {
    rawResponse: string;
    candidate: TextCandidateV3;
    receipt: SourceReceipt;
    storageId: string;
  },
) {
  const input: TextInput = source.task;
  const output = {
    ...textIdentity(input),
    provider: "retained-answer",
    rawResponse: at.rawResponse,
    candidate: at.candidate,
  };
  const prepared = derivedFiles(source, { output, receipt: at.receipt });
  const { result, completion, files } = prepared;
  const record = TextRecordSchema.parse({
    schemaVersion: 1,
    storageId: at.storageId,
    input,
    result,
    completion,
  });
  return { record, files };
}

export function derivedImage(
  source: Extract<RecheckSource, { kind: "image" }>,
  at: {
    candidate: LabelImageCandidate;
    rawResponse: string;
    status: "candidate" | "partial";
    receipt: SourceReceipt;
    storageId: string;
  },
) {
  const task: VisionTask = source.task;
  const { result, completion, files } = derivedFiles(source, {
    output: visionResponse(task, at.rawResponse),
    receipt: at.receipt,
  });
  const record = VisionRecordSchema.parse({
    schemaVersion: 2,
    codec: "vision-result/2",
    storageId: at.storageId,
    ...task,
    status: at.status,
    result,
    completion,
  });
  return { record, files };
}
