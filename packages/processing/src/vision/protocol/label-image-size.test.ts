import { describe, expect, it } from "vitest";
import { isCompleteLabelImage } from "@crawl-automation/v3-contracts";
import { decodeVisionResult } from "./vision-protocol.js";
import { MIN_LABEL_IMAGE_WIDTH, tooSmallAnswer, tooSmallLabelImage } from "./label-image-size.js";

/** A PNG header (signature and IHDR chunk) of the given size: all an image-size reader needs. */
function png(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  Buffer.from("0802000000", "hex").copy(bytes, 24);
  return bytes;
}

const task = { extractionProtocol: "label-extraction/1", operationId: "op-1" } as never;

describe("label images too small to read (owner 2026-11-05)", () => {
  it("holds back an image narrower than the minimum, whatever its height", () => {
    expect(tooSmallLabelImage(png(150, 482))).toEqual({ width: 150, height: 482 });
    expect(tooSmallLabelImage(png(MIN_LABEL_IMAGE_WIDTH - 1, 230))).not.toBeNull();
  });

  it("reads an image at least the minimum wide, including a wide strip of one printed line", () => {
    expect(tooSmallLabelImage(png(MIN_LABEL_IMAGE_WIDTH, 300))).toBeNull();
    expect(tooSmallLabelImage(png(1500, 104))).toBeNull();
  });

  it("leaves an image whose size cannot be read to the model", () => {
    expect(tooSmallLabelImage(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("decodes to a Review whose empty candidate never stands for a complete label", () => {
    const decoded = decodeVisionResult(task, tooSmallAnswer({ width: 198, height: 230 }));

    expect(decoded).toMatchObject({ status: "review", code: "VISION.LABEL_IMAGE_TOO_SMALL" });
    expect(decoded.candidate).toMatchObject({ formula: null, otherIngredients: null });
    expect(isCompleteLabelImage({ kind: "image", candidate: decoded.candidate as never })).toBe(
      false,
    );
  });
});
