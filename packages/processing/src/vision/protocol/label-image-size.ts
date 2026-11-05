import { imageSize } from "image-size";
import { z } from "zod";
import { LabelImageCandidateSchema } from "@crawl-automation/v3-contracts";
import { labelValidationErrors } from "../../label/validation-errors.js";

/**
 * Owner 2026-11-05: a label image this narrow prints its facts too small to read; it is never read by the model. In
 * a hand check of small images every one under this width that was read had a formula the image does not print
 * (MCHA 198 px, Lion's Mane 150 px, Folic Acid 191 px, Mg Oxide 237 px); readable ones were 249 px and wider.
 */
export const MIN_LABEL_IMAGE_WIDTH = 240;

const tooSmallAnswerSchema = z.strictObject({
  codec: z.literal("label-image-too-small/1"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  minWidth: z.number().int().positive(),
});

/** The image's size when it is too narrow to be read, else null (an unreadable header is left to the model). */
export function tooSmallLabelImage(bytes: Uint8Array): { width: number; height: number } | null {
  try {
    const { width, height } = imageSize(bytes);
    return width && height && width < MIN_LABEL_IMAGE_WIDTH ? { width, height } : null;
  } catch {
    return null;
  }
}

/** The retained answer for an image the model was never asked to read. */
export function tooSmallAnswer(size: { width: number; height: number }): string {
  return JSON.stringify({
    codec: "label-image-too-small/1",
    ...size,
    minWidth: MIN_LABEL_IMAGE_WIDTH,
  });
}

export function isTooSmallAnswer(raw: string): boolean {
  return JSON.parse(raw)?.codec === "label-image-too-small/1";
}

/** No label is read from the image: a Review, whose empty candidate never stands for a complete label. */
export function decodeTooSmallAnswer(raw: string) {
  const saved = tooSmallAnswerSchema.parse(JSON.parse(raw));
  const candidate = LabelImageCandidateSchema.parse({
    codec: "label-extraction/1",
    formula: null,
    otherIngredients: null,
    formulaComplete: false,
    ingredientsComplete: false,
    exclusions: [],
    issues: [
      {
        code: "UNREADABLE",
        detail: `The image is ${saved.width}×${saved.height} px, narrower than ${saved.minWidth} px; its print is too small to read.`,
      },
    ],
  });
  return {
    candidate,
    status: "review" as const,
    codes: [labelValidationErrors.code("LABEL.IMAGE_TOO_SMALL")],
  };
}
