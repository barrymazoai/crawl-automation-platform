import { imageSize } from "image-size";
import { isAppError } from "@crawl-automation/platform";
import { fileErrors } from "./file-errors.js";

function mediaTypeOf(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png" as const;
  }
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) {
    return "image/jpeg" as const;
  }
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp" as const;
  }
  if (/^%PDF-[12]\.\d/.test(bytes.toString("ascii", 0, 8))) {
    return "application/pdf" as const;
  }
  throw fileErrors.create("ARTIFACT.MEDIA_TYPE");
}

function checkContainer(bytes: Buffer, mediaType: string) {
  const complete = {
    "image/png": () => bytes.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex")),
    "image/jpeg": () => bytes.subarray(-2).equals(Buffer.from("ffd9", "hex")),
    "image/webp": () => bytes.readUInt32LE(4) + 8 === bytes.length,
  }[mediaType];
  if (!complete?.()) {
    throw fileErrors.create("ARTIFACT.INTEGRITY");
  }
}

function imageDimensions(
  bytes: Buffer,
  mediaType: Exclude<ReturnType<typeof mediaTypeOf>, "application/pdf">,
  maxPixels: number,
) {
  try {
    const dimensions = imageSize(bytes);
    if (
      !dimensions.width ||
      !dimensions.height ||
      dimensions.width * dimensions.height > maxPixels
    ) {
      throw fileErrors.create("ARTIFACT.DIMENSIONS");
    }
    if (
      dimensions.type !==
      { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[mediaType]
    ) {
      throw fileErrors.create("ARTIFACT.MEDIA_TYPE");
    }
    checkContainer(bytes, mediaType);
    return { width: dimensions.width, height: dimensions.height };
  } catch (cause) {
    if (isAppError(cause)) {
      throw cause;
    }
    throw fileErrors.create("ARTIFACT.INTEGRITY", { cause });
  }
}

export function inspectMedia(raw: Uint8Array, contentType: string | undefined, maxPixels: number) {
  const bytes = Buffer.from(raw);
  const declared = contentType?.split(";")[0]?.trim().toLowerCase();
  const mediaType = mediaTypeOf(bytes);
  if (declared && declared !== "application/octet-stream" && declared !== mediaType) {
    throw fileErrors.create("ARTIFACT.MEDIA_TYPE");
  }
  if (mediaType === "application/pdf") {
    // Preserve legacy download receipts; this is container screening, not a PDF processing route.
    if (!/%%EOF\s*$/.test(bytes.subarray(Math.max(0, bytes.length - 1024)).toString("ascii"))) {
      throw fileErrors.create("ARTIFACT.INTEGRITY");
    }
    return { mediaType, dimensions: null };
  }
  return { mediaType, dimensions: imageDimensions(bytes, mediaType, maxPixels) };
}
