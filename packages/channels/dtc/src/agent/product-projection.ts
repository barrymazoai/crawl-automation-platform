import { ChannelProductEvidenceSchema } from "@crawl-automation/v3-contracts";
import { completeFacts, schemaCommerce, type ParsedProduct } from "@crawl-automation/channels-core";
import { dtcProductAddress } from "../address.js";
import { assertDtcBrandVerified, dtcBrandEvidence } from "../brand-evidence.js";
import { dtcBrandSource } from "../brand-source.js";
import type { DtcSitePolicy } from "../site-policy.js";
import type { DtcRendered } from "../evidence.js";
import type { HarvestRecord, CaptureReview } from "./product-record.js";

/** Converts retained harvest evidence only; no fixed DOM/gallery selector or new website fetch. */
interface ProjectionInput {
  record: HarvestRecord;
  review: CaptureReview;
  site: DtcSitePolicy;
  url: string;
  sourceUrl?: string | undefined;
}

export function capturedProductProjection(input: ProjectionInput): ParsedProduct<DtcRendered> {
  const { record, review, site } = input;
  const address = dtcProductAddress(input.url, [site]);
  const source =
    input.sourceUrl && site.kind === "multi-brand" ? dtcBrandSource(input.sourceUrl, [site]) : null;
  const brandEvidence = dtcBrandEvidence(site, stringField(record, "brand"), source);
  assertDtcBrandVerified(brandEvidence);
  const identity = { listingId: address.listingId, variantId: review.selectedVariantId };
  const factsHtml = stringField(record, "supplement_facts") ?? stringField(record, "facts_table");
  const facts = completeFacts(record.variants.length > 1 ? null : factsHtml);
  const evidence = productEvidence(input, brandEvidence.observedBrand);
  return {
    channel: "dtc",
    identity,
    evidence,
    facts,
    commerce: schemaCommerce({ ...record.fields, priceCurrency: record.fields.currency }),
    variants: record.variants.flatMap((variant) =>
      variant.url ? [dtcProductAddress(variant.url, [site])] : [],
    ),
    rendered: {
      siteKey: site.siteKey,
      productId: address.listingId,
      brandEvidence,
      evidence,
      facts,
      platform: site.platform === "unverified" ? "jsonld" : site.platform,
    },
  };
}

function productEvidence(input: ProjectionInput, observedBrand: string | null) {
  const { record, review, site } = input;
  const address = dtcProductAddress(input.url, [site]);
  const factsHtml = stringField(record, "supplement_facts") ?? stringField(record, "facts_table");
  return ChannelProductEvidenceSchema.parse({
    codec: "channel-product/1",
    channel: "dtc",
    listingId: address.listingId,
    variantId: review.selectedVariantId,
    url: input.url,
    title: stringField(record, "title"),
    brandRaw: site.kind === "single-brand" ? site.siteKey : observedBrand,
    variantOptions: [],
    variants: record.variants.map((variant) => ({
      listingId: address.listingId,
      variantId: variant.variantId ?? null,
      title: variant.title ?? null,
      url: variant.url ?? input.url,
    })),
    detailsHtml: details(record),
    factsCandidates: factsHtml
      ? [
          {
            field: "supplement-facts",
            html: factsHtml,
            scope: record.variants.length > 1 ? "product-unassigned-variant" : "selected-product",
          },
        ]
      : [],
    imageCandidates: capturedImages(review, record.variants.length),
    warnings: record.flags,
  });
}

function capturedImages(review: CaptureReview, variantCount: number) {
  // Capture retains every image. Only the downstream planner decides variant-scoped use.
  return review.imageAssignments.map((image) => ({
    ...image,
    variantId:
      variantCount === 1 && image.variantId === null ? review.selectedVariantId : image.variantId,
    verifiedOriginal: false as const,
  }));
}

function stringField(record: HarvestRecord, key: string): string | null {
  const value = record.fields[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function details(record: HarvestRecord): string | null {
  const values = Object.entries(record.fields).filter(
    ([key, value]) =>
      typeof value === "string" &&
      !["title", "sku", "price", "currency", "brand", "supplement_facts", "facts_table"].includes(
        key,
      ),
  );
  return (
    values
      .map(
        ([key, value]) =>
          `<section><h2>${escape(key)}</h2><div>${escape(String(value))}</div></section>`,
      )
      .join("\n") || null
  );
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
