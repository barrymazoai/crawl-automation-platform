import {
  completeFacts,
  platformPageErrors,
  type ProductIdentity,
} from "@crawl-automation/channels-core";
import { ChannelProductEvidenceSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { dtcProductAddress, siteForUrl } from "./address.js";
import {
  assertDtcBrandVerified,
  dtcBrandEvidence,
  DtcBrandEvidenceSchema,
  dtcBrandWarnings,
} from "./brand-evidence.js";
import { dtcBrandSource, type DtcBrandSource } from "./brand-source.js";
import type { DtcRendered } from "./evidence.js";
import type { DtcSitePolicy } from "./site-policy.js";

const Projection = z.strictObject({
  codec: z.literal("dtc-product/2"),
  evidence: ChannelProductEvidenceSchema,
  brandEvidence: DtcBrandEvidenceSchema,
});

export function dtcProjection(rendered: DtcRendered) {
  if (
    rendered.brandEvidence.status === "site-brand" &&
    rendered.brandEvidence.source === null &&
    rendered.evidence.brandRaw === rendered.siteKey
  ) {
    return rendered.evidence;
  }
  return Projection.parse({
    codec: "dtc-product/2",
    evidence: rendered.evidence,
    brandEvidence: rendered.brandEvidence,
  });
}

function validateBrand(read: z.infer<typeof Projection>, site: DtcSitePolicy) {
  const { evidence, brandEvidence } = read;
  const source = brandEvidence.source;
  const configured = source ? dtcBrandSource(source.catalogUrl, [site]) : null;
  const expected = dtcBrandEvidence(site, brandEvidence.observedBrand, configured);
  const brand = expected.observedBrand;
  if (
    !isDeepStrictEqual(brandEvidence, expected) ||
    evidence.brandRaw !== brand ||
    dtcBrandWarnings(expected).some((code) => !evidence.warnings.includes(code))
  ) {
    throw platformPageErrors.create("DTC.IDENTITY_CONFLICT");
  }
  assertDtcBrandVerified(expected);
}

function projectionData(projection: unknown, site: DtcSitePolicy) {
  const wrapped = Projection.safeParse(projection);
  if (wrapped.success) {
    validateBrand(wrapped.data, site);
    return { evidence: wrapped.data.evidence, source: wrapped.data.brandEvidence.source };
  }
  const evidence = ChannelProductEvidenceSchema.parse(projection);
  if (site.kind !== "single-brand" || evidence.brandRaw !== site.siteKey) {
    throw platformPageErrors.create("DTC.IDENTITY_CONFLICT");
  }
  return { evidence, source: null };
}

export function readDtcProjection(
  projection: unknown,
  expected: { url: string; owner: ProductIdentity },
  scope: { sites: readonly DtcSitePolicy[]; source: DtcBrandSource | null },
) {
  const site = siteForUrl(expected.url, scope.sites);
  const { evidence, source } = projectionData(projection, site);
  const address = dtcProductAddress(expected.url, scope.sites);
  const actual = dtcProductAddress(evidence.url, scope.sites);
  if (
    evidence.channel !== "dtc" ||
    evidence.listingId !== expected.owner.listingId ||
    evidence.variantId !== expected.owner.variantId ||
    actual.listingId !== address.listingId ||
    (scope.source && source?.sourceId !== scope.source.sourceId)
  ) {
    throw platformPageErrors.create("DTC.IDENTITY_CONFLICT");
  }
  const selected = evidence.factsCandidates.find((entry) => entry.scope === "selected-product");
  return { evidence, facts: completeFacts(selected?.html ?? null) };
}
