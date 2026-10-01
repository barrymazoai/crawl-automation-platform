import { DefaultKeywordPolicy, type OcrInput } from "@crawl-automation/v3-contracts";
import { entry, owner } from "../../label/label-fixture.js";

function ocrRef(task: OcrInput, name: string) {
  return {
    ...task.file,
    artifactId: name,
    objectKey: `ocr/${name}.json`,
    kind: "result-json",
    mediaType: "application/json",
    producer: {
      operationId: task.operationId,
      module: task.module,
      implementationVersion: task.implementationVersion,
    },
  };
}

export function imageEvidence(task: OcrInput) {
  const registration = {
    schemaVersion: 1,
    storageId: "test/1",
    input: task,
    result: ocrRef(task, "result"),
    completion: ocrRef(task, "completion"),
  };
  const selection = {
    schemaVersion: 1,
    observation: owner,
    image: task.file,
    ocrOperationId: task.operationId,
    ocrTextSha256: "a".repeat(64),
    policy: DefaultKeywordPolicy,
    policyFingerprint: "b".repeat(64),
    status: "matched",
    matchedKeywords: ["Supplement Facts"],
  };
  const source = {
    id: "image",
    required: true,
    kind: "image",
    task: {
      configFingerprint: entry.input.visionConfigFingerprint,
      input: { operationId: "label-vision", extractionProtocol: "label-extraction/1", selection },
    },
  };
  return { registration, selection, source };
}

export function imageActivities(task: OcrInput, image: ReturnType<typeof imageEvidence>) {
  return {
    prepareImageOcr: async () => ({ status: "prepared", task, evidenceKey: "replay/ocr.json" }),
    ocrFile: async () => ({
      status: "registered",
      operationId: task.operationId,
      resultRegistered: true,
      result: image.registration.result,
      completion: image.registration.completion,
    }),
    resolveOcrReceipt: async () => ({ status: "registered", registration: image.registration }),
    screenImageKeywords: async () => ({
      status: "matched",
      imageId: task.file.artifactId,
      evidenceKey: "keywords/image.json",
      selection: image.selection,
    }),
    prepareLabelSource: async (request: unknown) => ({
      status: "prepared",
      input: request,
      source: image.source,
    }),
    interpretImage: async () => ({ status: "registered", operationId: "label-vision" }),
  };
}
