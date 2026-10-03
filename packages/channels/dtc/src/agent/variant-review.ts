import { z } from "zod";
import { FamilyDifferenceSchema } from "@crawl-automation/channels-core";

const proof = {
  variantId: z.string().min(1),
  reason: z.string().min(1).max(4000),
  evidence: z.array(z.string()).min(1).max(200),
};
const observed = z.strictObject({
  ...proof,
  status: z.literal("observed"),
  methodPath: z.string().min(1),
  detailCoveragePath: z.string().min(1).optional(),
  galleryUrls: z.array(z.url()).min(1).max(100),
  galleryReview: z
    .array(
      z.strictObject({
        url: z.url(),
        status: z.enum(["applicable", "other-variant", "unresolved"]),
        basis: z.enum(["website-binding", "visual-content", "website-shared"]).optional(),
        reason: z.string().min(1).max(4000),
        evidence: z.array(z.string().min(1)).min(1).max(200),
      }),
    )
    .min(1)
    .max(100),
  difference: z.strictObject({ kind: FamilyDifferenceSchema, group: z.string().min(1) }).optional(),
});
const location = {
  source: z.number().int().nonnegative(),
  format: z.enum(["raw", "html-text"]).optional(),
};
const scopeRule = z.union([
  z.strictObject({
    ...location,
    selector: z.string().min(1),
    attribute: z.string().min(1).optional(),
  }),
  z.strictObject({ ...location, pointer: z.string().startsWith("/") }),
]);
const selectedState = z.strictObject({ rule: scopeRule, value: z.string().min(1) }).optional();
export const VariantContextSchema = z.union([
  observed.extend({ basis: z.literal("variant-state"), selectedState }),
  observed.extend({
    basis: z.literal("website-shared"),
    sharedScope: z.strictObject({ rule: scopeRule, text: z.string().min(1).max(16000) }),
  }),
  z.strictObject({
    ...proof,
    status: z.literal("mixed"),
    basis: z.literal("variant-state"),
    methodPath: z.string().min(1),
    detailCoveragePath: z.string().min(1).optional(),
    selectedState,
    galleryUrls: z.array(z.url()).min(1).max(100),
  }),
  z.strictObject({ ...proof, status: z.literal("unresolved") }),
]);
export type ObservedVariantContext = Extract<
  z.infer<typeof VariantContextSchema>,
  { status: "observed" | "mixed" }
>;
