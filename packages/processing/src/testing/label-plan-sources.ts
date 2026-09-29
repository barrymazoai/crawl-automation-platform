import {
  acquisitionFingerprintMaterial,
  type ArtifactRef,
  type FileAcquireInput,
  type SavedEvidenceSource,
  type TextInput,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import type { SourceResolution } from "../label/label-plan-model.js";
import { screenKeywords } from "../keywords/keyword-screen.js";
import { hashString } from "../results/result-record.js";
import { pageSetup } from "./page-fixture.js";

/** The page fixture's observation, which every label source here belongs to. */
export const planOwner = {
  schemaVersion: 1 as const,
  requestId: "req-1",
  observationId: "obs-1",
  brandId: "brand-1",
  sourceId: "source-1",
  listingId: "listing-1",
  variantId: null,
};

const ocr = {
  schemaVersion: 1 as const,
  module: "ocr.file" as const,
  implementationVersion: "multipart-ocr/2",
  policyVersion: "single-call/1",
  resultSchemaVersion: 2 as const,
  configFingerprint: "a".repeat(64),
};

function downloadTask(index: number): FileAcquireInput {
  const unsigned = {
    ...planOwner,
    operationId: `file-op-${index}`,
    module: "file.acquire" as const,
    implementationVersion: "1",
    policyVersion: "1",
    configFingerprint: "c".repeat(64),
    inputFingerprint: "0".repeat(64),
    resourceId: `image-${index}`,
    binding: { sessionId: "session-1", egressId: "direct/1" },
    expectedSha256: null,
  };
  return { ...unsigned, inputFingerprint: hashString(acquisitionFingerprintMaterial(unsigned)) };
}

function downloadedImage(acquire: FileAcquireInput, index: number): ArtifactRef {
  const producer = {
    operationId: acquire.operationId,
    module: "file.acquire",
    implementationVersion: "1",
  };
  return {
    schemaVersion: 1,
    artifactId: `file-${hashString(acquire.operationId)}`,
    observationId: planOwner.observationId,
    sourceId: planOwner.sourceId,
    listingId: planOwner.listingId,
    variantId: null,
    kind: "source-image",
    mediaType: "image/png",
    sha256: "e".repeat(64),
    byteSize: 8,
    objectKey: `images/${index}.png`,
    producer,
  };
}

/** An image source: its saved plan, the vision task its prepared evidence resolves to, and its image URL. */
export function planImageSource(index: number, at: { text: string; factsIndex: number }) {
  const acquire = downloadTask(index);
  const image = downloadedImage(acquire, index);
  const ocrOperationId = `ocr-op-${index}`;
  const source: SavedEvidenceSource = {
    id: `image-${index}`,
    kind: "file-image",
    required: true,
    plan: { imageId: image.artifactId, acquire, ocrOperationId, ocr },
    visionOperationId: `vision-op-${index}`,
    configFingerprint: "f".repeat(64),
  };
  const selection = screenKeywords({
    observation: planOwner,
    image,
    ocrOperationId,
    text: at.text,
  });
  const task: VisionTask = {
    input: { operationId: `vision-op-${index}`, selection },
    configFingerprint: "f".repeat(64),
  };
  const matched = {
    status: "resolved" as const,
    source: { id: source.id, kind: "image" as const, required: true, task },
  };
  const resolution: SourceResolution =
    selection.status === "matched" ? matched : { status: "not_matched" };
  const name = index === at.factsIndex ? "supplement-facts" : "front";
  return { source, resolution, url: `https://cdn.example/${name}-${index}.png` };
}

/** A prepared page as a saved source, with the text task it resolves to. */
export async function planPageSource() {
  const page = pageSetup();
  const receipt = await page.preparation.run(page.input, AbortSignal.timeout(10_000));
  const prepared = await page.text.run({ plan: page.plan, receipt }, AbortSignal.timeout(10_000));
  if (prepared.status !== "prepared") {
    throw new Error(JSON.stringify(prepared));
  }
  const source: SavedEvidenceSource = { id: "page", kind: "page", required: true, plan: page.plan };
  const task = prepared.task as TextInput;
  const resolution: SourceResolution = {
    status: "resolved",
    source: { id: "page", kind: "text", required: true, task },
  };
  return { page, source, task, resolution };
}
