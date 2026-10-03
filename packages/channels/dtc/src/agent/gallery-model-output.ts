import { z } from "zod";
import { DtcGalleryDecisionSchema } from "@crawl-automation/v3-contracts";

// Root object for structured output, with semantic branches enforced before model submission.
export const GalleryModelOutput = z.strictObject({
  decision: z.union([
    DtcGalleryDecisionSchema.extend({
      kind: z.literal("facts"),
      variantIds: z.array(z.string().min(1)).min(1).max(200),
      basis: z.enum(["label-content", "website-shared"]),
      imageEvidence: z.string().min(1).max(16000),
      websiteEvidence: z.string().min(1).max(16000),
    }),
    DtcGalleryDecisionSchema.extend({
      kind: z.literal("other"),
      variantIds: z.array(z.string()).max(0),
      basis: z.literal("not-facts"),
    }),
    DtcGalleryDecisionSchema.extend({
      kind: z.literal("unresolved"),
      variantIds: z.array(z.string()).max(0),
      basis: z.literal("unresolved"),
    }),
  ]),
});
