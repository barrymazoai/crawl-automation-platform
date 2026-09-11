import { fingerprint, sha256 } from "../contracts/fingerprint.js";
import { CONFIG, IMPLEMENTATION, POLICY, type OcrInput } from "../contracts/index.js";

export function makeFixture(id: string): OcrInput {
  const input: Omit<OcrInput, "inputFingerprint"> = {
    schemaVersion: 1,
    module: "ocr.file",
    resultSchemaVersion: 1,
    configFingerprint: sha256(CONFIG),
    requestId: `req-${id}`,
    observationId: `obs-${id}`,
    operationId: `ocr-${id}`,
    brandId: "brand-p0",
    sourceId: "source-p0",
    listingId: "listing-p0",
    variantId: null,
    implementationVersion: IMPLEMENTATION,
    policyVersion: POLICY,
    file: {
      schemaVersion: 1,
      artifactId: `file-${id}`,
      observationId: `obs-${id}`,
      listingId: "listing-p0",
      sourceId: "source-p0",
      variantId: null,
      producer: { operationId: `capture-${id}`, module: "capture.mock", implementationVersion: "mock-capture/1" },
      kind: "source-image",
      mediaType: "image/png",
      sha256: "a".repeat(64),
      byteSize: 100,
      objectKey: `sources/${id}.png`,
    },
  };
  return { ...input, inputFingerprint: fingerprint(input) };
}
