import { randomUUID } from "node:crypto";
import { sha256 } from "@crawl-automation/v3-artifacts";
import {
  fingerprintOcrInput,
  processingIdentity,
  type OcrInput,
  type ArtifactRef,
  type OcrOutput,
  type OcrRegistration,
  type OcrResponse,
} from "@crawl-automation/v3-contracts";
import { OcrResults } from "../ocr/ocr-results.js";
import { OcrStep } from "../ocr/ocr-step.js";
import { hashString } from "../results/result-record.js";
import type { ResultRegistry } from "../results/result-kind.js";
import { MemoryRegistry, MemoryReviews } from "./memory-ledgers.js";
import { MemoryStore } from "./memory-store.js";

export const signal = () => new AbortController().signal;
export const STORAGE_ID = "fixture-r2/1";
export const PNG = Buffer.from("89504e470d0a1a0a", "hex");

/** A signed OCR task for one PNG image, with the fingerprint recomputed after any change. */
export function ocrTask(changes: Partial<OcrInput> = {}): OcrInput {
  const id = randomUUID();
  const unsigned = {
    schemaVersion: 1 as const,
    requestId: `req-${id}`,
    observationId: `obs-${id}`,
    operationId: `op-${id}`,
    module: "ocr.file" as const,
    brandId: "brand-test",
    sourceId: "source-test",
    listingId: `listing-${id}`,
    variantId: null,
    implementationVersion: "multipart-ocr/2",
    policyVersion: "single-call/1",
    resultSchemaVersion: 2 as const,
    configFingerprint: "a".repeat(64),
    file: imageRef(id),
    ...changes,
  };
  return { ...unsigned, inputFingerprint: fingerprintOcrInput(unsigned, hashString) };
}

function imageRef(id: string): OcrInput["file"] {
  return {
    schemaVersion: 1,
    artifactId: `source-${id}`,
    observationId: `obs-${id}`,
    sourceId: "source-test",
    listingId: `listing-${id}`,
    variantId: null,
    kind: "source-image",
    mediaType: "image/png",
    objectKey: `sources/${id}.png`,
    sha256: sha256(PNG),
    byteSize: PNG.length,
    producer: {
      operationId: `capture-${id}`,
      module: "capture",
      implementationVersion: "capture/1",
    },
  };
}

/** A resigned copy of a task with some fields changed. */
export function resigned(input: OcrInput, changes: Partial<OcrInput>): OcrInput {
  const { inputFingerprint: _old, ...unsigned } = { ...input, ...changes };
  return { ...unsigned, inputFingerprint: fingerprintOcrInput(unsigned, hashString) };
}

export function ocrOutput(input: OcrInput, text = "Supplement Facts\nVitamin C 10 mg"): OcrOutput {
  return {
    ...processingIdentity(input),
    resultSchemaVersion: 2,
    text,
    rawResponse: { text, lines: [{ text, score: 0.99 }] },
    provider: "fake-ocr/1",
  };
}

/** An OCR task whose image is in R2, with a local store, an R2 store and a ledger. */
export function ocrSetup(registry: ResultRegistry<OcrRegistration> | null = new MemoryRegistry()) {
  const input = ocrTask();
  const local = new MemoryStore();
  const remote = new MemoryStore();
  remote.data.set(input.file.objectKey, PNG);
  const results = new OcrResults({ local, remote, registry, storageId: STORAGE_ID });
  return { input, output: ocrOutput(input), local, remote, registry, results };
}

/** Reads an image from R2 by its reference, as the artifact resolver would. */
export function remoteArtifacts(remote: MemoryStore) {
  return {
    resolve: async (ref: ArtifactRef) => {
      const bytes = await remote.read(ref.objectKey, ref.byteSize);
      if (!bytes) {
        throw new Error("image missing");
      }
      return { ref, bytes, from: "remote" as const, cacheRetained: false };
    },
  };
}

/** A fake OCR API that counts its calls. */
export function fakeOcrApi(
  input: OcrInput,
  text = "  Supplement Facts\nIngredients: test only.  ",
) {
  const api = {
    provider: "fake-ocr/1",
    supported: ocrCompatibilityOf(input),
    calls: 0,
    recognize: async (): Promise<OcrResponse> => {
      api.calls++;
      return { text, lines: [] };
    },
  };
  return api;
}

function ocrCompatibilityOf(input: OcrInput) {
  const { module, schemaVersion, implementationVersion, policyVersion } = input;
  return {
    module,
    schemaVersion,
    implementationVersion,
    policyVersion,
    resultSchemaVersion: 2 as const,
    configFingerprint: input.configFingerprint,
  };
}

/** The OCR step wired to memory stores, a memory ledger and a fake OCR API. */
export function ocrStepSetup(mode: "register" | "upload-only" = "register") {
  const registry = new MemoryRegistry<OcrRegistration>();
  const fixture = ocrSetup(mode === "register" ? registry : null);
  const api = fakeOcrApi(fixture.input);
  const reviews = new MemoryReviews();
  const deps = {
    api,
    artifacts: remoteArtifacts(fixture.remote),
    results: fixture.results,
    remote: fixture.remote,
    reviews,
    nodeId: "node-a",
    storageId: STORAGE_ID,
    mode,
  };
  return { ...fixture, registry, api, reviews, deps, step: new OcrStep(deps) };
}
