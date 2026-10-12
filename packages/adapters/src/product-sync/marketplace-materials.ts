import { canonicalHash, productDeliveryErrors } from "@crawl-automation/app";
import type {
  MarketplaceChannels,
  MarketplaceHistory,
  MarketplaceProduct,
} from "@crawl-automation/app/marketplace-mapping";
import type { ObjectStore, Queryable } from "@crawl-automation/platform";
import { z } from "zod";
import { checkedCollectedProduct } from "../postgres/postgres-collected-products.js";
import { deliveryEnrichment } from "../product-delivery/delivery-enrichment.js";
import { retainedProjection } from "../product-delivery/retained-projection.js";
import {
  MARKETPLACE_AMAZON_LABEL,
  MARKETPLACE_COLLECTION,
  MARKETPLACE_HISTORY,
} from "./marketplace-queries.js";

export interface MarketplaceReaderDependencies {
  database: Queryable;
  objects: Pick<ObjectStore, "read">;
  channels: MarketplaceChannels;
}
const History = z.object({
  codec: z.literal("v3-capture-history/1"),
  observationId: z.string().min(1),
  capturedAt: z.iso.datetime({ offset: true }),
  listing: z.object({ channel: z.string(), externalId: z.string(), url: z.url() }),
  owner: z.object({
    runId: z.string(),
    sourceId: z.string(),
    brandId: z.string(),
    operationId: z.string(),
  }),
  capture: z.object({ variantId: z.string().nullable() }),
  metrics: z.record(z.string(), z.unknown()),
  evidence: z.array(z.object({ objectKey: z.string(), sha256: z.string() })),
});
interface CollectedRow {
  operation_id: string;
  observation_id: string;
  record_hash: string;
  record: unknown;
  run_id?: string;
  source_id?: string;
  url?: string;
  variant_id?: string | null;
}

export class MarketplaceMaterials {
  constructor(private readonly deps: MarketplaceReaderDependencies) {}

  async read(input: MarketplaceProduct, signal: AbortSignal): Promise<MarketplaceProduct> {
    const history = await this.history(input);
    if (!history) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.MATERIAL_MISSING");
    }
    const row = await this.collected(input);
    const collection = row ? checkedCollectedProduct(row, row.operation_id) : null;
    const labelChannel = input.channel === "wholefoods" ? "amazon" : input.channel;
    const enrichment = collection
      ? await deliveryEnrichment(this.deps.database, collection, labelChannel)
      : null;
    const labelHistory = await this.labelHistory(input, row);
    const references = materialReferences(input, { enrichment, history });
    const product = await retainedProjection(
      {
        objects: this.deps.objects,
        references,
        decode: (raw) => this.decode(raw, { ...input, history, collection }),
      },
      signal,
    );
    if (!product) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.MATERIAL_MISSING");
    }
    return { ...input, history, collection, enrichment, product, labelHistory };
  }

  private async labelHistory(input: MarketplaceProduct, row: CollectedRow | null) {
    if (!row || input.channel !== "wholefoods") {
      return null;
    }
    return this.history({
      ...input,
      channel: "amazon",
      runId: row.run_id ?? "",
      sourceId: row.source_id ?? "",
      url: row.url ?? "",
      variantId: row.variant_id ?? null,
    });
  }

  private decode(raw: unknown, input: MarketplaceProduct & { history: MarketplaceHistory }) {
    const adapter = this.deps.channels.get(input.channel);
    if (typeof raw === "string") {
      const parsed = adapter.parseProduct({
        html: raw,
        url: input.history.listing.url,
        capturedAt: input.history.capturedAt,
      });
      return parsed.evidence;
    }
    const owner = input.collection?.observation;
    return owner && adapter.planning ? adapter.planning.read(raw, input.url, owner).evidence : null;
  }

  private async collected(input: MarketplaceProduct) {
    const wholeFoods = input.channel === "wholefoods";
    const rows = await this.deps.database.query<CollectedRow>(
      wholeFoods ? MARKETPLACE_AMAZON_LABEL : MARKETPLACE_COLLECTION,
      wholeFoods ? [input.listingId] : [input.runId, input.sourceId, input.variantId],
    );
    // A run with multiple distinct unassigned labels needs an explicit variant, never "first label wins".
    if (
      new Set(
        rows.map((row) => canonicalHash((row.record as { observation: unknown }).observation)),
      ).size > 1
    ) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
    }
    return rows[0] ?? null;
  }

  private async history(input: MarketplaceProduct): Promise<MarketplaceHistory | null> {
    const rows = await this.deps.database.query<{ record: unknown; body_hash: string }>(
      MARKETPLACE_HISTORY,
      [input.channel, input.runId, input.sourceId, input.url, input.variantId],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    if (canonicalHash(row.record) !== row.body_hash) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
    }
    return History.parse(row.record);
  }
}

function materialReferences(
  input: MarketplaceProduct,
  material: Pick<MarketplaceProduct, "enrichment"> & { history: MarketplaceHistory },
) {
  // The Amazon enrichment may describe a Whole Foods label, never its page or gallery.
  const title = input.channel === "wholefoods" ? null : material.enrichment?.subject.titleEvidence;
  return [
    ...(title ? [{ objectKey: title.sourceId, sha256: title.sha256 }] : []),
    ...material.history.evidence,
  ];
}
