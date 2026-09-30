import { z } from "zod";
import { DtcBrandSourceSchema, type DtcBrandSource } from "./brand-source.js";
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
      : !observedBrand
        ? "unverified"
        : !source
          ? "unscoped"
          : observedBrand.trim().toLowerCase() === source.brand.trim().toLowerCase()
            ? "matched"
            : "mismatch";
  return { seller: site.siteKey, source, observedBrand, status };
}

export function dtcBrandWarnings(evidence: DtcBrandEvidence): string[] {
  if (evidence.status === "mismatch") {
    return [dtcEvidenceErrors.code("DTC.BRAND_MISMATCH")];
  }
  return evidence.status === "unverified" ? [dtcEvidenceErrors.code("DTC.BRAND_UNVERIFIED")] : [];
}
