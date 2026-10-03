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
  detailsHtml?: string | undefined;
  /** Host verified a separate model-observed context for this exact website variant. */
  variantContextVerified?: boolean;
  /** Selection is verified even when the gallery still needs DTC scope processing. */
  variantStateVerified?: boolean;
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
  const facts = completeFacts(unassigned(input) ? null : factsHtml);
  const evidence = productEvidence(input, brandEvidence.observedBrand);
  return {
    channel: "dtc",
    identity,
    evidence,
    facts,
    commerce: capturedCommerce(record, variantId),
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

function capturedCommerce(record: HarvestRecord, variantId: string | null) {
  const variant =
    variantId === null ? undefined : record.variants.find((item) => item.variantId === variantId);
  const fields = { ...record.fields, ...variant };
  return schemaCommerce({ ...fields, priceCurrency: fields.currency });
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
    brandRaw: observedBrand,
    variantOptions: capturedVariantOptions(input),
    variants: record.variants.map((variant) => ({
      listingId: address.listingId,
      variantId: variant.variantId ?? null,
      title: variant.title ?? null,
      url: variant.url ?? input.url,
      sku: variant.sku,
      options: variant.options,
      price: variant.price,
      availability: variant.availability,
      available: variant.available,
      imageUrl: variant.imageUrl,
    })),
    detailsHtml: input.detailsHtml ?? details(record),
    factsCandidates: factsHtml
      ? [
          {
            field: "supplement-facts",
            html: factsHtml,
            scope: unassigned(input) ? "product-unassigned-variant" : "selected-product",
          },
        ]
      : [],
    imageCandidates: capturedImages(input),
    warnings: record.flags,
  });
}

function unassigned(input: ProjectionInput) {
  return input.record.variants.length > 1 && !input.variantContextVerified;
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
    address.variantId ??
    (input.variantStateVerified || input.record.variants.length <= 1
      ? input.review.selectedVariantId
      : null)
  );
}

function capturedImages(input: ProjectionInput) {
  const { review, record } = input;
  // Preserve known website bindings in the actual handoff, as well as the originals.
  // Mixed-variant processing remains subject to the downstream planner's isolation checks.
  return review.imageAssignments.map((image) => ({
    ...image,
    variantId:
      record.variants.length === 1 && image.variantId === null
        ? review.selectedVariantId
        : image.variantId,
    verifiedOriginal: false as const,
  }));
}

function stringField(record: HarvestRecord, key: string): string | null {
  const value = record.fields[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function details(record: HarvestRecord): string | null {
  const method = record["fieldEvidence"] as
    { fields?: Record<string, { format?: string }> } | undefined;
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
          `<section><h2>${escape(key)}</h2><div>${method?.fields?.[key]?.format === "html" ? String(value) : escape(String(value))}</div></section>`,
      )
      .join("\n") || null
  );
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
