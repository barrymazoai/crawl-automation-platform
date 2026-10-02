import { z } from "zod";
import { DtcBrandSourceSchema, sameDtcBrand, type DtcBrandSource } from "./brand-source.js";
import { dtcEvidenceErrors } from "./evidence-errors.js";
import type { DtcSitePolicy } from "./site-policy.js";

export const DtcBrandEvidenceSchema = z.strictObject({
  seller: z.string().min(1),
  source: DtcBrandSourceSchema.nullable(),
  observedBrand: z.string().max(1000).nullable(),
  status: z.enum(["site-brand", "matched", "mismatch", "unverified", "unscoped"]),
});
export type DtcBrandEvidence = z.infer<typeof DtcBrandEvidenceSchema>;

/** Only trim/case are normalized; aliases or similar names never merge brands. */
export function dtcBrandEvidence(
  site: DtcSitePolicy,
  observedBrand: string | null,
  source: DtcBrandSource | null,
): DtcBrandEvidence {
  const status =
    site.kind === "single-brand"
      ? "site-brand"
      : !observedBrand?.trim()
        ? "unverified"
        : !source
          ? "unscoped"
          : sameDtcBrand(observedBrand, source.brand)
            ? "matched"
            : "mismatch";
  return { seller: site.siteKey, source, observedBrand, status };
}

/** Missing identity is a Review, never a source-derived brand or a claim that the page is gone. */
export function assertDtcBrandVerified(evidence: DtcBrandEvidence): void {
  if (evidence.status === "mismatch") {
    throw dtcEvidenceErrors.create("DTC.BRAND_MISMATCH", { details: { ...evidence } });
  }
  if (evidence.status === "unverified") {
    throw dtcEvidenceErrors.create("DTC.BRAND_UNVERIFIED", { details: { ...evidence } });
  }
  if (evidence.status === "unscoped") {
    throw dtcEvidenceErrors.create("DTC.BRAND_SOURCE_REQUIRED", { details: { ...evidence } });
  }
}

export function dtcBrandWarnings(evidence: DtcBrandEvidence): string[] {
  if (evidence.status === "mismatch") {
    return [dtcEvidenceErrors.code("DTC.BRAND_MISMATCH")];
  }
  return evidence.status === "unverified" ? [dtcEvidenceErrors.code("DTC.BRAND_UNVERIFIED")] : [];
}
