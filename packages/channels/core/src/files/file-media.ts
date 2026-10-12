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

/** Diagnostic signatures only: these formats remain rejected by mediaTypeOf. */
function rejectedMediaTypeOf(bytes: Buffer): string | null {
  if (/^GIF8[79]a/.test(bytes.toString("ascii", 0, 6))) {
    return "image/gif";
  }
  if (bytes.toString("ascii", 4, 8) === "ftyp") {
    const end = Math.min(bytes.readUInt32BE(0), bytes.length, 256);
    for (let offset = 8; offset + 4 <= end; offset += 4) {
      if (offset !== 12 && /^(avif|avis)$/.test(bytes.toString("ascii", offset, offset + 4))) {
        return "image/avif";
      }
    }
  }
  const prefix = bytes
    .toString("utf8", 0, 512)
    .replace(/^\uFEFF/, "")
    .trimStart();
  return /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(prefix) ? "text/html" : null;
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

function assertContentType(contentType: string | undefined, mediaType: string) {
  const declared = contentType?.split(";")[0]?.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && declared !== mediaType) {
    throw fileErrors.create("ARTIFACT.MEDIA_TYPE");
  }
}

export function inspectMedia(raw: Uint8Array, contentType: string | undefined, maxPixels: number) {
  const bytes = Buffer.from(raw);
  let sniffedMediaType: string | null = null;
  try {
    const mediaType = mediaTypeOf(bytes);
    sniffedMediaType = mediaType;
    assertContentType(contentType, mediaType);
    if (mediaType === "application/pdf") {
      // Preserve legacy download receipts; this is container screening, not a PDF processing route.
      if (!/%%EOF\s*$/.test(bytes.subarray(Math.max(0, bytes.length - 1024)).toString("ascii"))) {
        throw fileErrors.create("ARTIFACT.INTEGRITY");
      }
      return { mediaType, dimensions: null };
    }
    return { mediaType, dimensions: imageDimensions(bytes, mediaType, maxPixels) };
  } catch (error) {
    if (fileErrors.is(error, "ARTIFACT.MEDIA_TYPE")) {
      Object.assign(error.details, {
        contentType: contentType ?? null,
        sniffedMediaType: sniffedMediaType ?? rejectedMediaTypeOf(bytes),
        byteSize: bytes.length,
      });
    }
    throw error;
  }
}
