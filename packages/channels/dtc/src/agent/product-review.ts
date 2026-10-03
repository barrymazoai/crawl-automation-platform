import { z } from "zod";
import { dtcAgentErrors } from "./errors.js";
import { VariantContextSchema } from "./variant-review.js";

export const CaptureReviewSchema = z.object({
  productUrl: z.url(),
  selectedVariantId: z.string().nullable(),
  galleryUrls: z.array(z.url()).min(1),
  galleryComplete: z.literal(true),
  variantsComplete: z.literal(true),
  detailComplete: z.literal(true),
  detailCoveragePath: z.string().min(1).optional(),
  method: z.string().min(1),
  surface: z.literal("local_file"),
  verifier: z.literal("codex"),
  evidence: z.array(z.string()).min(1),
  // Validate independently: one bad variant must not discard the other retained variants.
  variantContexts: z.array(z.unknown()).max(200).optional(),
  materialScopes: z.array(z.unknown()).max(200).optional(),
  imageAssignments: z
    .array(
      z.object({
        url: z.url(),
        variantId: z.string().nullable(),
        basis: z.enum(["product-gallery", "variant-featured"]),
      }),
    )
    .min(1),
});
export type CaptureReview = z.infer<typeof CaptureReviewSchema>;

// Authoring must expose the full contract; ingestion still isolates bad siblings independently.
export const CaptureReviewAuthoringSchema = CaptureReviewSchema.extend({
  detailCoveragePath: z.string().min(1),
  variantContexts: z.array(VariantContextSchema).max(200).optional(),
});

export function parseCaptureReview(raw: unknown): CaptureReview {
  const result = CaptureReviewSchema.safeParse(raw);
  if (!result.success) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE", {
      details: { reason: "invalid_capture_review", issues: result.error.issues },
    });
  }
  return result.data;
}
