import { imageSize } from "image-size";
import { AcquisitionError } from "./ports.js";
export function inspectMedia(bytes: Uint8Array, contentType: string | undefined, maxPixels: number) {
    const b = Buffer.from(bytes), declared = contentType?.split(";")[0]?.trim().toLowerCase();
    let mediaType: "image/png" | "image/jpeg" | "image/webp" | "application/pdf";
    if (b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
        mediaType = "image/png";
    else if (b.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")))
        mediaType = "image/jpeg";
    else if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP")
        mediaType = "image/webp";
    else if (/^%PDF-[12]\.\d/.test(b.toString("ascii", 0, 8)))
        mediaType = "application/pdf";
    else
        throw new AcquisitionError("ARTIFACT.MEDIA_TYPE");
    if (declared && declared !== "application/octet-stream" && declared !== mediaType)
        throw new AcquisitionError("ARTIFACT.MEDIA_TYPE");
    if (mediaType === "application/pdf") {
        // Container screening only; page count, encryption and rendering belong to PDFium module.
        if (!/%%EOF\s*$/.test(b.subarray(Math.max(0, b.length - 1024)).toString("ascii")))
            throw new AcquisitionError("ARTIFACT.INTEGRITY");
        return { mediaType, dimensions: null };
    }
    try {
        const dimensions = imageSize(bytes);
        if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > maxPixels)
            throw new AcquisitionError("ARTIFACT.DIMENSIONS");
        if (dimensions.type !== ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[mediaType]))
            throw new AcquisitionError("ARTIFACT.MEDIA_TYPE");
        if (mediaType === "image/png" && !b.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex")))
            throw new AcquisitionError("ARTIFACT.INTEGRITY");
        if (mediaType === "image/jpeg" && !b.subarray(-2).equals(Buffer.from("ffd9", "hex")))
            throw new AcquisitionError("ARTIFACT.INTEGRITY");
        if (mediaType === "image/webp" && b.readUInt32LE(4) + 8 !== b.length)
            throw new AcquisitionError("ARTIFACT.INTEGRITY");
        return { mediaType, dimensions: { width: dimensions.width, height: dimensions.height } };
    }
    catch (error) {
        if (error instanceof AcquisitionError)
            throw error;
        throw new AcquisitionError("ARTIFACT.INTEGRITY");
    }
}
