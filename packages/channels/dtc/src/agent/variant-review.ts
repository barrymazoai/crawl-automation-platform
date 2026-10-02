import { z } from "zod";
import { FamilyDifferenceSchema } from "@crawl-automation/channels-core";

const proof = {
  variantId: z.string().min(1),
  reason: z.string().min(1).max(4000),
  evidence: z.array(z.string()).min(1).max(200),
};
export const VariantContextSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...proof,
    status: z.literal("observed"),
    methodPath: z.string().min(1),
    galleryUrls: z.array(z.url()).min(1).max(100),
    basis: z.enum(["variant-state", "website-shared"]),
    difference: z
      .strictObject({ kind: FamilyDifferenceSchema, group: z.string().min(1) })
      .optional(),
  }),
  z.strictObject({ ...proof, status: z.literal("unresolved") }),
]);
export type ObservedVariantContext = Extract<
  z.infer<typeof VariantContextSchema>,
  { status: "observed" }
>;
