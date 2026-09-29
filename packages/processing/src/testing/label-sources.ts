import { readFileSync } from "node:fs";
import { sha256 } from "@crawl-automation/v3-artifacts";
import {
  ArtifactRefSchema,
  ObservationSchema,
  TextCandidateV3Schema,
  TextInputSchema,
  TextRecordSchema,
  VisionRecordSchema,
  textFingerprint,
  type ArtifactRef,
  type LabelImageCandidate,
  type Observation,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import type { VerifiedLabelSource } from "../assembly/label-merge.js";
import { screenKeywords } from "../keywords/keyword-screen.js";
import { hashString } from "../results/result-record.js";

const CANDIDATE = new URL("../assembly/fixtures/label-candidate.json", import.meta.url);

/** A complete, hand-transcribed label (structural fixture, not a model answer). A fresh copy each call. */
export const labelCandidate = (): LabelImageCandidate =>
  JSON.parse(readFileSync(CANDIDATE, "utf8"));

export const visionFingerprint = (task: VisionTask) =>
  hashString(JSON.stringify(["vision-input/1", task.input, task.configFingerprint]));

export const fixtureObservation: Observation = ObservationSchema.parse({
  schemaVersion: 1,
  requestId: "request",
  observationId: "observation",
  brandId: "brand",
  sourceId: "source",
  listingId: "listing",
  variantId: null,
});

/** An artifact of the fixture observation. */
function ownedRef(
  objectKey: string,
  producer: ArtifactRef["producer"],
  image = false,
): ArtifactRef {
  const bytes = Buffer.from(objectKey);
  const { observationId, sourceId, listingId, variantId } = fixtureObservation;
  return ArtifactRefSchema.parse({
    schemaVersion: 1,
    artifactId: objectKey.replace(/[^a-z0-9-]/gi, "-"),
    observationId,
    sourceId,
    listingId,
    variantId,
    kind: image ? "source-image" : "result-json",
    mediaType: image ? "image/png" : "application/json",
    sha256: sha256(bytes),
    byteSize: bytes.length,
    objectKey,
    producer,
  });
}

/** An image source with its registered vision record, as a verified reader would return it. */
export function imageSource(candidate: LabelImageCandidate, index: number) {
  const download = { operationId: "download", module: "file.acquire", implementationVersion: "1" };
  const image = ownedRef(`images/image-${index}.png`, download, true);
  const observation = fixtureObservation;
  const selection = screenKeywords({
    observation,
    image,
    ocrOperationId: `ocr-${index}`,
    text: "Supplement Facts",
  });
  const input = {
    operationId: `label-source-${index}`,
    extractionProtocol: "label-extraction/1" as const,
    selection,
  };
  const task = { input, configFingerprint: "a".repeat(64) };
  const producer = {
    operationId: input.operationId,
    module: "codex.vision",
    implementationVersion: "vision/2",
  };
  const record = VisionRecordSchema.parse({
    schemaVersion: 2,
    codec: "vision-result/2",
    storageId: "test/1",
    input,
    configFingerprint: task.configFingerprint,
    status: "candidate",
    result: ownedRef(`v3/vision/${input.operationId}/response.json`, producer),
    completion: ownedRef(`v3/vision/${input.operationId}/completion.json`, producer),
  });
  const entry: VerifiedLabelSource = { id: `source-${index}`, kind: "image", record, candidate };
  return { source: { id: entry.id, kind: "image" as const, required: true, task }, entry };
}

/** The label's quoted fields laid out one per line in a synthetic full text, with their positions. */
function quotedLabel(text: LabelImageCandidate) {
  let fullText = "";
  const quote = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(quote);
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    if ("text" in value && "evidence" in value) {
      const start = fullText.length;
      const quoted = String(value.text);
      fullText += `${quoted}\n`;
      return { text: quoted, start, end: start + quoted.length };
    }
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, quote(inner)]));
  };
  const candidate = TextCandidateV3Schema.parse({ ...(quote(text) as object), schemaVersion: 3 });
  return { candidate, fullText };
}

/** The label as a registered text source over its synthetic full text. */
export function textEntry(text: LabelImageCandidate): VerifiedLabelSource & { kind: "text" } {
  const { candidate, fullText } = quotedLabel(text);
  const page = { operationId: "page-op", module: "page.prepare", implementationVersion: "1" };
  const unsigned = {
    ...fixtureObservation,
    operationId: "text-op",
    module: "codex.text" as const,
    implementationVersion: "codex-text/3",
    policyVersion: "label-text/4",
    resultSchemaVersion: 3 as const,
    configFingerprint: "c".repeat(64),
    source: {
      kind: "prepared" as const,
      document: ownedRef("v3/pages/page-op/document.json", page),
    },
    range: { start: 0, end: fullText.length },
  };
  const input = TextInputSchema.parse({
    ...unsigned,
    inputFingerprint: textFingerprint(unsigned, hashString),
  });
  const producer = {
    module: input.module,
    operationId: input.operationId,
    implementationVersion: input.implementationVersion,
  };
  const record = TextRecordSchema.parse({
    schemaVersion: 1,
    storageId: "synthetic/1",
    input,
    result: ownedRef("synthetic-text/result.json", producer),
    completion: ownedRef("synthetic-text/completion.json", producer),
  });
  return { id: "a-text", kind: "text", record, candidate, fullText };
}
