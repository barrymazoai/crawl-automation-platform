import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  ChannelProductEvidenceSchema,
  EnrichmentSubjectSchema,
  LabelCollectedProductSchema,
  SharedEnrichmentRecordSchema,
} from "@crawl-automation/v3-contracts";
import {
  MARKETPLACE_CHANNELS,
  type MarketplaceHistory,
  type MarketplaceProduct,
} from "./marketplace-model.js";

interface RawSample {
  channel: string;
  listingId: string;
  variantId: string | null;
  url: string;
  runId: string;
  sourceId: string;
  brand: string;
  collected?: unknown[] | null;
  history?: unknown[] | null;
  enrichment?: { subject: unknown; record: unknown }[] | null;
}

/**
 * 15 real completed runs (2026-10-12). Real crawler data is not in git (owner 2026-09-30): tests read the file named
 * by CRAWLER_MARKETPLACE_SAMPLES and are skipped without it. Provenance: docs/quality/2026-10-12-marketplace-mapping.md.
 */
export const marketplaceSamplesPath = process.env["CRAWLER_MARKETPLACE_SAMPLES"];
const samples: RawSample[] = marketplaceSamplesPath
  ? (JSON.parse(readFileSync(marketplaceSamplesPath, "utf8")) as RawSample[])
  : [];

export function marketplaceSamples(): MarketplaceProduct[] {
  return samples.map((sample) => {
    const attached = sample.enrichment?.[0];
    const enrichment = attached
      ? {
          ...SharedEnrichmentRecordSchema.parse(attached.record),
          subject: EnrichmentSubjectSchema.parse(attached.subject),
        }
      : null;
    const collection = sample.collected?.[0]
      ? LabelCollectedProductSchema.parse(sample.collected[0])
      : null;
    const channel = z.enum(MARKETPLACE_CHANNELS).parse(sample.channel);
    const product = sampleProjection(sample, enrichment);
    return {
      channel,
      listingId: sample.listingId,
      variantId: sample.variantId,
      url: sample.url,
      runId: sample.runId,
      sourceId: sample.sourceId,
      brand: sample.brand,
      collection,
      enrichment,
      product,
      history: (sample.history?.[0] as MarketplaceHistory | undefined) ?? null,
    };
  });
}

function sampleProjection(sample: RawSample, enrichment: MarketplaceProduct["enrichment"]) {
  const channel = sample.channel;
  const subject = enrichment?.subject;
  // Samples contain projection REFERENCES, not their bytes. This minimal scaffold uses only the real
  // subject's identity/title. Gallery/structured metadata are exercised separately with explicit test inputs.
  return subject?.title
    ? ChannelProductEvidenceSchema.parse({
        codec: "channel-product/1",
        channel,
        listingId: subject.listingId,
        variantId: subject.variantId,
        url: sample.url,
        title: subject.title,
        brandRaw: sample.brand,
        variantOptions: [],
        variants: [],
        detailsHtml: null,
        factsCandidates: [],
        imageCandidates: [],
        warnings: [],
      })
    : null;
}
export function required<Value>(value: Value | null | undefined): Value {
  if (value === undefined || value === null) {
    throw new Error("Missing required test fixture value");
  }
  return value;
}
