import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Client } from "pg";
import { canonicalHash } from "@crawl-automation/app";
import type {
  MarketplaceChannels,
  MarketplaceHistory,
  MarketplaceProduct,
} from "@crawl-automation/app/marketplace-mapping";
import { enrichmentHash, labelCollectedHash } from "@crawl-automation/processing";
import {
  ChannelProductEvidenceSchema,
  EnrichmentSubjectSchema,
  LabelCollectedProductSchema,
  SharedEnrichmentRecordSchema,
} from "@crawl-automation/v3-contracts";

/** Real crawler data is not in git (owner 2026-09-30); see docs/quality/2026-10-12-marketplace-mapping.md. */
export const readerSamplesPath = process.env["CRAWLER_MARKETPLACE_SAMPLES"];
const rawSamples: unknown = readerSamplesPath
  ? JSON.parse(readFileSync(readerSamplesPath, "utf8"))
  : [];
const Sample = z.object({
  channel: z.enum(["amazon", "gnc", "swanson", "wholefoods", "costco"]),
  listingId: z.string(),
  variantId: z.string().nullable(),
  url: z.string(),
  runId: z.string(),
  sourceId: z.string(),
  brand: z.string(),
  collected: z.array(LabelCollectedProductSchema).nullable(),
  history: z.array(z.unknown()),
  enrichment: z
    .array(z.object({ record: SharedEnrichmentRecordSchema, subject: EnrichmentSubjectSchema }))
    .nullable(),
});

export function readerSamples(): MarketplaceProduct[] {
  return z
    .array(Sample)
    .parse(rawSamples)
    .map((raw) => {
      const attached = raw.enrichment?.[0];
      const enrichment = attached ? { ...attached.record, subject: attached.subject } : null;
      const history = raw.history[0] as MarketplaceHistory;
      const collection = firstCollection(raw);
      const product = ChannelProductEvidenceSchema.parse({
        codec: "channel-product/1",
        channel: raw.channel,
        listingId: collection?.observation.listingId ?? raw.listingId,
        variantId: collection?.observation.variantId ?? raw.variantId,
        url: raw.url,
        title: enrichment?.subject.title ?? "Explicit retained Whole Foods projection test double",
        brandRaw: raw.brand,
        variantOptions: [],
        variants: [],
        detailsHtml: null,
        factsCandidates: [],
        imageCandidates: [],
        warnings: [],
      });
      return { ...raw, history, collection, enrichment, product };
    });
}
export const readerTables = `
  CREATE TABLE brand(id uuid PRIMARY KEY, name text);
  CREATE TABLE brand_source(id uuid PRIMARY KEY, channel text, brand_id uuid);
  CREATE TABLE queue_item(item_id text PRIMARY KEY, source_id uuid, channel text, listing_id text,
    variant_id text, url text, state text, run_id uuid, created_at timestamptz, follows_item_id text, reason text);
  CREATE TABLE queue_attempt(run_id uuid PRIMARY KEY, item_id text, channel text, settled_at timestamptz, outcome text);
  CREATE TABLE formula_link(channel text, listing_id text, variant_id text, formula_operation_id text, created_at timestamptz);
  CREATE TABLE collected_product(operation_id text, observation_id text, record_hash text, record jsonb, collected_at timestamptz);
  CREATE TABLE product_history_source(source_record_id text, record jsonb, body_hash text);
  CREATE TABLE product_enrichment_subject(subject_id text, enrichment_id text, collection_operation_id text,
    channel text, listing_id text, variant_id text, subject jsonb, registered_at timestamptz);
  CREATE TABLE product_enrichment(enrichment_id text, record_hash text, record jsonb);
  CREATE TABLE supply_smart_brand_company(brand_id uuid PRIMARY KEY, status text);
  CREATE TABLE product_sync(channel text, listing_id text, variant_key text, status text, material_at timestamptz);
  CREATE TABLE listing_state_observation(run_id uuid, state text);`;

/** Fixture hashes are recomputed after documented trimming/scaffolding; production hashes are never rewritten. */
export async function seedReaderSample(
  client: Client,
  input: MarketplaceProduct,
  objects: Map<string, Uint8Array>,
) {
  const { history, product, collection, enrichment } = input;
  if (!history || !product) {
    throw new Error("Missing fixture material");
  }
  const brandId = history.owner.brandId;
  await client.query("INSERT INTO brand VALUES ($1,$2) ON CONFLICT DO NOTHING", [
    brandId,
    input.brand,
  ]);
  for (const sourceId of new Set([input.sourceId, history.owner.sourceId])) {
    await client.query("INSERT INTO brand_source VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [
      sourceId,
      input.channel,
      brandId,
    ]);
  }
  await seedQueue(client, input);
  fixtureProjection(input, objects);
  await client.query("INSERT INTO product_history_source VALUES ($1,$2::jsonb,$3)", [
    history.observationId,
    JSON.stringify(history),
    canonicalHash(history),
  ]);
  if (collection) {
    await client.query("INSERT INTO collected_product VALUES ($1,$2,$3,$4::jsonb,now())", [
      collection.operationId,
      collection.observation.observationId,
      labelCollectedHash(collection),
      JSON.stringify(collection),
    ]);
  }
  if (enrichment) {
    await seedEnrichment(client, enrichment);
  }
}

function firstCollection(raw: z.infer<typeof Sample>) {
  return raw.collected?.[0] ?? null;
}
function fixtureProjection(input: MarketplaceProduct, objects: Map<string, Uint8Array>) {
  if (!input.history || !input.product) {
    throw new Error("Missing projection fixture");
  }
  const bytes = Buffer.from(JSON.stringify(input.product));
  const reference = {
    objectKey: `test-projections/${input.runId}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  objects.set(reference.objectKey, bytes);
  if (input.enrichment) {
    input.enrichment.subject.titleEvidence = {
      sourceId: reference.objectKey,
      sha256: reference.sha256,
    };
  }
  input.history.evidence = [reference];
}
async function seedQueue(client: Client, input: MarketplaceProduct) {
  await client.query("INSERT INTO queue_item VALUES ($1,$2,$3,$4,$5,$6,'completed',$7,now())", [
    input.runId,
    input.sourceId,
    input.channel,
    input.listingId,
    input.variantId,
    input.url,
    input.runId,
  ]);
  await client.query("INSERT INTO queue_attempt VALUES ($1::uuid,$1::text,$2,now(),'completed')", [
    input.runId,
    input.channel,
  ]);
}
async function seedEnrichment(
  client: Client,
  record: NonNullable<MarketplaceProduct["enrichment"]>,
) {
  const subject = record.subject;
  await client.query("INSERT INTO product_enrichment VALUES ($1,$2,$3::jsonb)", [
    record.enrichmentId,
    enrichmentHash(record),
    JSON.stringify(record),
  ]);
  await client.query(
    "INSERT INTO product_enrichment_subject VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now())",
    [
      enrichmentHash([subject, record.enrichmentId]),
      record.enrichmentId,
      subject.collectionOperationId,
      subject.channel,
      subject.listingId,
      subject.variantId,
      JSON.stringify(subject),
    ],
  );
}

/** Explicit registry double: projections are scaffolded from real records, no parser output is claimed. */
export const readerChannels: MarketplaceChannels = {
  channels: () => ["amazon", "wholefoods", "gnc", "swanson", "costco"],
  get: (channel) => ({
    id: channel,
    ...(channel === "amazon" || channel === "wholefoods" ? { formulaFamily: "amazon-asin" } : {}),
    captureModes: ["http"],
    httpPolicy: { origins: [], maxBytes: 1024, timeoutMs: 1000 },
    productAddress: () => {
      throw new Error("Fixture projections should not parse a URL");
    },
    parseProduct: () => {
      throw new Error("Fixture projections should not call a channel parser");
    },
  }),
};
