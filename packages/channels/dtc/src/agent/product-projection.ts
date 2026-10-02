import { ChannelProductEvidenceSchema } from "@crawl-automation/v3-contracts";
import { completeFacts, schemaCommerce, type ParsedProduct } from "@crawl-automation/channels-core";
import { dtcProductAddress } from "../address.js";
import { assertDtcBrandVerified, dtcBrandEvidence } from "../brand-evidence.js";
import { dtcBrandSource } from "../brand-source.js";
import type { DtcSitePolicy } from "../site-policy.js";
import type { DtcRendered } from "../evidence.js";
import type { HarvestRecord, CaptureReview } from "./product-record.js";
import { capturedProductBrand } from "./product-brand.js";

/** Converts retained harvest evidence only; no fixed DOM/gallery selector or new website fetch. */
interface ProjectionInput {
  record: HarvestRecord;
  review: CaptureReview;
  site: DtcSitePolicy;
  url: string;
  sourceUrl?: string | undefined;
  html?: Uint8Array;
}

export function capturedProductProjection(input: ProjectionInput): ParsedProduct<DtcRendered> {
  const { record, site } = input;
  const address = dtcProductAddress(input.url, [site]);
  const source =
    input.sourceUrl && site.kind === "multi-brand" ? dtcBrandSource(input.sourceUrl, [site]) : null;
  const brandEvidence = dtcBrandEvidence(site, capturedProductBrand(input), source);
  assertDtcBrandVerified(brandEvidence);
  const variantId = captureVariant(input);
  const identity = { listingId: address.listingId, variantId };
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
  const { record, site } = input;
  const address = dtcProductAddress(input.url, [site]);
  const factsHtml = stringField(record, "supplement_facts") ?? stringField(record, "facts_table");
  return ChannelProductEvidenceSchema.parse({
    codec: "channel-product/1",
    channel: "dtc",
    listingId: address.listingId,
    variantId: captureVariant(input),
    url: input.url,
    title: stringField(record, "title"),
    brandRaw: site.kind === "single-brand" ? site.siteKey : observedBrand,
    variantOptions: capturedVariantOptions(input),
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
    imageCandidates: capturedImages(input),
    warnings: record.flags,
  });
}

function capturedVariantOptions(input: ProjectionInput): string[] {
  const variantId = captureVariant(input);
  const variants = input.record.variants;
  const selected =
    variantId === null ? variants : variants.filter((variant) => variant.variantId === variantId);
  const options = selected.length === 1 ? selected[0]?.["options"] : null;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return [];
  }
  return Object.entries(options).flatMap(([name, value]) =>
    typeof value === "string" && value.trim() ? [`${name}: ${value}`] : [],
  );
}

function captureVariant(input: ProjectionInput) {
  const address = dtcProductAddress(input.url, [input.site]);
  // A base-product task must not become a variant task merely because the page selected a default.
  return (
    address.variantId ?? (input.record.variants.length > 1 ? null : input.review.selectedVariantId)
  );
}

function capturedImages(input: ProjectionInput) {
  const { review, record } = input;
  const baseProduct = record.variants.length > 1 && captureVariant(input) === null;
  // Website bindings remain byte-exact in archived capture-review.json and records.json.
  // Match the legacy base-product handoff; explicit variant tasks retain strict source isolation.
  return review.imageAssignments.map((image) => ({
    ...image,
    variantId: baseProduct
      ? null
      : record.variants.length === 1 && image.variantId === null
        ? review.selectedVariantId
        : image.variantId,
    basis: baseProduct ? ("product-gallery" as const) : image.basis,
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
