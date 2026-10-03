import { expect, it, vi } from "vitest";
import { ArtifactResolver, sha256 } from "@crawl-automation/platform";
import type { OcrInput } from "@crawl-automation/v3-contracts";
import type { WorkerParts } from "../container.js";
import { dtcGalleryModelActivities } from "./dtc-gallery-activities.js";

// Isolate providers and Temporal, while exercising the actual activity wiring and artifact resolver.
vi.mock("./activity-guard.js", () => ({
  guarded:
    (_name: string, handler: (raw: unknown, signal: AbortSignal) => unknown) => (raw: unknown) =>
      handler(raw, new AbortController().signal),
}));
vi.mock("@crawl-automation/processing", () => ({
  CodexVisionConfigSchema: { parse: () => ({}) },
  CodexClient: { open: async () => ({ close: async () => undefined }) },
}));
vi.mock("@crawl-automation/channel-dtc", async (original) => ({
  ...(await original<typeof import("@crawl-automation/channel-dtc")>()),
  DtcGalleryScope: class {
    constructor(
      _gallery: unknown,
      private ports: { image(input: OcrInput, signal: AbortSignal): Promise<Uint8Array> },
    ) {}
    run(input: OcrInput, signal: AbortSignal) {
      return this.ports.image(input, signal);
    }
  },
}));

const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK3sAAAAASUVORK5CYII=",
  "base64",
);
const owner = {
  schemaVersion: 1 as const,
  requestId: "request",
  observationId: "observation",
  brandId: "brand",
  sourceId: "source",
  listingId: "listing",
  variantId: null,
};
const input: OcrInput = {
  ...owner,
  operationId: "gallery-ocr",
  module: "ocr.file",
  implementationVersion: "ocr/1",
  policyVersion: "evidence/1",
  resultSchemaVersion: 2,
  configFingerprint: "c".repeat(64),
  inputFingerprint: "f".repeat(64),
  file: {
    schemaVersion: 1,
    observationId: owner.observationId,
    sourceId: owner.sourceId,
    listingId: owner.listingId,
    variantId: null,
    artifactId: "gallery-image",
    kind: "source-image",
    mediaType: "image/png",
    objectKey: "capture/image.png",
    sha256: sha256(bytes),
    byteSize: bytes.length,
    producer: {
      operationId: "capture",
      module: "dtc.browser-original",
      implementationVersion: "dtc-agent/1",
    },
  },
};
function activity() {
  const artifacts = new ArtifactResolver(
    { read: async () => bytes, retain: async () => undefined },
    { read: async () => null, create: async () => "created" },
  );
  return dtcGalleryModelActivities({
    config: {},
    label: { stores: { artifacts } },
  } as unknown as WorkerParts).scopeDtcGalleryImage;
}

it("loads the mixed-gallery original through strict ownership and byte-integrity checks", async () => {
  expect(await activity()(input)).toEqual(bytes);
});

it("refuses bytes that differ from the retained gallery reference", async () => {
  await expect(
    activity()({ ...input, file: { ...input.file, sha256: "a".repeat(64) } }),
  ).rejects.toThrow();
});

it.each(["sourceId", "observationId", "listingId", "variantId"] as const)(
  "still rejects a gallery image belonging to another %s",
  async (field) => {
    await expect(
      activity()({ ...input, file: { ...input.file, [field]: "different" } }),
    ).rejects.toThrow("ARTIFACT.OWNERSHIP_CONFLICT");
  },
);
