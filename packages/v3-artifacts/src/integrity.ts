import { createHash } from "node:crypto";
import type { ArtifactRef } from "@crawl-automation/v3-contracts";
import { ArtifactError } from "./ports.js";

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Container/signature screening, not an image decoder or a PDF security validator. */
export function verifyBytes(ref: ArtifactRef, bytes: Uint8Array, limit: number): void {
  if (bytes.byteLength > limit || ref.byteSize > limit) throw new ArtifactError("ARTIFACT.TOO_LARGE");
  if (bytes.byteLength !== ref.byteSize || sha256(bytes) !== ref.sha256) throw new ArtifactError("ARTIFACT.INTEGRITY");
  const prefix = Buffer.from(bytes.subarray(0, 16));
  let matches = false;
  switch (ref.mediaType) {
    case "image/png": matches = prefix.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")); break;
    case "image/jpeg": matches = prefix.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")); break;
    case "image/webp": matches = prefix.toString("ascii", 0, 4) === "RIFF" && prefix.toString("ascii", 8, 12) === "WEBP"; break;
    case "application/pdf": matches = prefix.toString("ascii", 0, 5) === "%PDF-"; break;
    case "text/plain":
    case "text/html":
    case "application/json":
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (ref.mediaType === "application/json") JSON.parse(text);
        matches = !text.includes("\0");
      } catch { matches = false; }
  }
  if (!matches) throw new ArtifactError("ARTIFACT.MEDIA_TYPE");
}
