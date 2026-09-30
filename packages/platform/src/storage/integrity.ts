import { createHash } from "node:crypto";
import type { ArtifactRef } from "@crawl-automation/v3-contracts";
import { artifactErrors } from "./artifact-errors.js";
import { matchesMediaType } from "./media-signatures.js";

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export function verifyBytes(ref: ArtifactRef, bytes: Uint8Array, limit: number): void {
  if (bytes.byteLength > limit || ref.byteSize > limit) {
    throw artifactErrors.create("ARTIFACT.TOO_LARGE");
  }
  if (bytes.byteLength !== ref.byteSize || sha256(bytes) !== ref.sha256) {
    throw artifactErrors.create("ARTIFACT.INTEGRITY");
  }
  if (!matchesMediaType(ref.mediaType, bytes)) {
    throw artifactErrors.create("ARTIFACT.MEDIA_TYPE");
  }
}
