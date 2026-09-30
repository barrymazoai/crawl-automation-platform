import type { ArtifactRef } from "@crawl-automation/v3-contracts";

function validText(bytes: Uint8Array, json: boolean): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (json) {
      JSON.parse(text);
    }
    return !text.includes("\0");
  } catch {
    return false;
  }
}

/** Container/signature screening, not an image decoder or a PDF security validator. */
export function matchesMediaType(mediaType: ArtifactRef["mediaType"], bytes: Uint8Array) {
  const prefix = Buffer.from(bytes.subarray(0, 16));
  switch (mediaType) {
    case "image/png":
      return prefix.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    case "image/jpeg":
      return prefix.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
    case "image/webp":
      return (
        prefix.toString("ascii", 0, 4) === "RIFF" && prefix.toString("ascii", 8, 12) === "WEBP"
      );
    case "application/pdf":
      return prefix.toString("ascii", 0, 5) === "%PDF-";
    case "text/plain":
    case "text/html":
    case "application/json":
      return validText(bytes, mediaType === "application/json");
    default:
      return false;
  }
}
