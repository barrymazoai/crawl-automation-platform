import { sha256 } from "@crawl-automation/v3-artifacts";
import type {
  ArtifactRef,
  Observation,
  VisionCandidate,
  VisionRecord,
  VisionTask,
} from "@crawl-automation/v3-contracts";
import { screenKeywords } from "../keywords/keyword-screen.js";
import fixture from "../vision/fixtures/gnc-label-candidate.json" with { type: "json" };
import { CodexVisionModel } from "../vision/codex-vision-model.js";
import { VisionEvidence } from "../vision/vision-evidence.js";
import { VisionRecovery } from "../vision/vision-recovery.js";
import { VisionResults } from "../vision/vision-results.js";
import { VisionStep } from "../vision/vision-step.js";
import { MemoryRegistry, MemoryReviews } from "./memory-ledgers.js";
import { MemoryStore } from "./memory-store.js";

export const signal = () => new AbortController().signal;
export const STORAGE_ID = "fixture-r2/1";

export const observation: Observation = {
  schemaVersion: 1,
  requestId: "request-1",
  observationId: "observation-1",
  brandId: "brand-1",
  sourceId: "source-1",
  listingId: "listing-1",
  variantId: null,
};
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
export const image: ArtifactRef = {
  schemaVersion: 1,
  artifactId: "image-1",
  observationId: observation.observationId,
  sourceId: observation.sourceId,
  listingId: observation.listingId,
  variantId: null,
  sha256: sha256(JPEG),
  byteSize: JPEG.length,
  objectKey: "images/image-1.jpg",
  kind: "source-image",
  mediaType: "image/jpeg",
  producer: {
    operationId: "download-1",
    module: "file.acquire",
    implementationVersion: "fixture/1",
  },
};
export const selection = (text = "Supplement Facts") =>
  screenKeywords({ observation, image, ocrOperationId: "ocr-1", text });

const field = (text: string) => ({ text, evidence: text });
/** A clean answer in the old vision-candidate/1 format. */
export const legacyCandidate: VisionCandidate = {
  schemaVersion: 1,
  formula: {
    servingSize: field("1 capsule"),
    servingsPerContainer: null,
    columns: [
      {
        heading: "Per serving",
        nutrients: [{ name: field("Blend"), amount: field("10 mg"), dailyValue: null }],
      },
    ],
  },
  ingredients: [
    { name: "Ginger root", evidence: "Ginger root", role: "blend_component", parentBlend: "Blend" },
  ],
  formulaComplete: true,
  ingredientsComplete: true,
  issues: [],
};

/** A label-extraction/1 vision setup (never opened: no Codex runs in tests). */
export const labelConfig = {
  settings: { model: "gpt-5.6-luna", provider: "openai", reasoningEffort: "medium" },
  executable: "/fixture/codex",
  codexHome: "/fixture/profile",
  workRoot: "/fixture/work",
  runtimeProfileVersion: "gnclive/1",
  timeoutMs: 240_000,
  extractionProtocol: "label-extraction/1" as const,
};

/** A clean label answer, as the model would return it. */
export const labelAnswer = () => JSON.stringify(fixture);

/** A label task pinned to the fixture setup. */
export function visionTask(): VisionTask {
  const configFingerprint = CodexVisionModel.describe(labelConfig).configFingerprint;
  const input = {
    operationId: "vision-label-1",
    selection: selection(),
    extractionProtocol: "label-extraction/1" as const,
  };
  return { input, configFingerprint };
}

/** A fake model that counts its calls and gives one fixed answer. */
function fakeVisionModel(task: VisionTask, answer: string) {
  const model = {
    fingerprint: task.configFingerprint,
    extractionProtocol: "label-extraction/1" as const,
    calls: 0,
    interpret: async (): Promise<string> => (model.calls++, answer),
  };
  return model;
}

/** Memory stores with the image in R2, a memory ledger and Review ledger, and a switchable OCR check. */
function visionStores() {
  const local = new MemoryStore();
  const remote = new MemoryStore();
  remote.data.set(image.objectKey, JPEG);
  const ocr = { verified: true, verifiedText: async () => ocrText(ocr.verified) };
  const evidence = new VisionEvidence({
    local,
    remote,
    verifyOcr: async () => void (await ocr.verifiedText()),
  });
  return {
    local,
    remote,
    ocr,
    evidence,
    registry: new MemoryRegistry<VisionRecord>(),
    reviews: new MemoryReviews(),
  };
}

/** The vision step on memory stores, a memory ledger, a fake OCR check and a fake model. */
export function visionSetup(options: { answer?: string; mode?: "register" | "upload-only" } = {}) {
  const { answer = labelAnswer(), mode = "register" } = options;
  const stores = visionStores();
  const task = visionTask();
  const model = fakeVisionModel(task, answer);
  const registry = mode === "register" ? stores.registry : null;
  const resultDeps = { ...stores, registry, storageId: STORAGE_ID };
  const results = new VisionResults(resultDeps);
  const recovery = new VisionRecovery(results, resultDeps);
  const artifacts = {
    resolve: async () => ({
      ref: image,
      bytes: JPEG,
      from: "remote" as const,
      cacheRetained: false,
    }),
  };
  const deps = { ...stores, model, results, ocrText: stores.ocr, artifacts, mode };
  return { ...stores, task, model, results, recovery, deps, step: new VisionStep(deps) };
}

async function ocrText(verified: boolean): Promise<string> {
  if (!verified) {
    throw new Error("OCR not registered");
  }
  return "Supplement Facts";
}
