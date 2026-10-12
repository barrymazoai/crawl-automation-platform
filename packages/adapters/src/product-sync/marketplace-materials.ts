import {
  canonicalHash,
  FormulaLookup,
  formulaFamilies,
  productDeliveryErrors,
} from "@crawl-automation/app";
import {
  MARKETPLACE_CHANNELS,
  type MarketplaceChannels,
  type MarketplaceHistory,
  type MarketplaceProduct,
} from "@crawl-automation/app/marketplace-mapping";
import type { ObjectStore, Queryable } from "@crawl-automation/platform";
import { z } from "zod";
import { checkedCollectedProduct } from "../postgres/postgres-collected-products.js";
import { PostgresFormulaIndex } from "../postgres/postgres-formula-index.js";
import { deliveryEnrichment } from "../product-delivery/delivery-enrichment.js";
import { retainedProjection } from "../product-delivery/retained-projection.js";
import {
  MARKETPLACE_COLLECTION,
  MARKETPLACE_HISTORY,
  MARKETPLACE_LABEL_HISTORY,
  MARKETPLACE_LINKED_COLLECTION,
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
}

type ProjectionInput = Pick<MarketplaceProduct, "collection" | "enrichment" | "channel"> & {
  history: MarketplaceHistory;
};

export class MarketplaceMaterials {
  constructor(private readonly deps: MarketplaceReaderDependencies) {}

  async read(input: MarketplaceProduct, signal: AbortSignal): Promise<MarketplaceProduct> {
    const history = await this.history(MARKETPLACE_HISTORY, [
      input.channel,
      input.runId,
      input.sourceId,
      input.url,
      input.variantId,
    ]);
    const collection = await this.collected(input);
    const enrichment = collection
      ? await deliveryEnrichment(this.deps.database, collection, input.channel)
      : null;
    const product = await this.projection(
      { history, collection, enrichment, channel: input.channel },
      signal,
    );
    const own = { ...input, history, collection, enrichment, product };
    return collection ? own : this.withKnownFormula(own, signal);
  }

  private async withKnownFormula(
    input: MarketplaceProduct & {
      history: MarketplaceHistory;
      product: NonNullable<MarketplaceProduct["product"]>;
    },
    signal: AbortSignal,
  ): Promise<MarketplaceProduct> {
    // ProductSourcePlans takes parsed.identity: these IDs come from this capture's retained page,
    // not the queue handle or commerce externalId (both differ from the owner for Swanson).
    const { listingId, variantId } = input.product;
    const families = formulaFamilies(this.deps.channels);
    const known = await new FormulaLookup(
      new PostgresFormulaIndex(this.deps.database),
      families,
    ).findKnown({ channel: input.channel, listingId, variantId });
    if (!known) {
      return input;
    }
    const donor = await this.donor(known.operationId, families.channels(input.channel), signal);
    const owner = donor.collection.observation;
    // A sibling formula must not supply the target's name, size, gallery or selected options.
    const enrichment =
      owner.listingId === listingId && owner.variantId === variantId ? donor.enrichment : null;
    return {
      ...input,
      collection: donor.collection,
      enrichment,
      linkedLabel: {
        target: { listingId, variantId },
        operationId: known.operationId,
        history: donor.history,
        product: donor.product,
      },
    };
  }

  private async donor(operationId: string, channels: string[], signal: AbortSignal) {
    const rows = await this.deps.database.query<CollectedRow & { channel: string }>(
      MARKETPLACE_LINKED_COLLECTION,
      [operationId],
    );
    const row = rows[0];
    if (!row || !channels.includes(row.channel)) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
    }
    const collection = checkedCollectedProduct(row, operationId);
    const channel = z.enum(MARKETPLACE_CHANNELS).parse(row.channel);
    const owner = collection.observation;
    const history = await this.history(MARKETPLACE_LABEL_HISTORY, [
      channel,
      owner.requestId,
      owner.sourceId,
      owner.variantId,
    ]);
    const product = await this.projection(
      { history, collection, enrichment: null, channel },
      signal,
    );
    const enrichment = await deliveryEnrichment(this.deps.database, collection, channel);
    return { collection, history, product, enrichment };
  }

  private async projection(input: ProjectionInput, signal: AbortSignal) {
    const title = input.enrichment?.subject.titleEvidence;
    const product = await retainedProjection(
      {
        objects: this.deps.objects,
        references: [
          ...(title ? [{ objectKey: title.sourceId, sha256: title.sha256 }] : []),
          ...input.history.evidence,
        ],
        decode: (raw) => {
          const adapter = this.deps.channels.get(input.channel);
          if (typeof raw === "string") {
            const parsed = adapter.parseProduct({
              html: raw,
              url: input.history.listing.url,
              capturedAt: input.history.capturedAt,
            });
            if (
              parsed.identity.listingId !== parsed.evidence.listingId ||
              parsed.identity.variantId !== parsed.evidence.variantId
            ) {
              throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
            }
            return parsed.evidence;
          }
          const owner = input.collection?.observation;
          return owner && adapter.planning
            ? adapter.planning.read(raw, input.history.listing.url, owner).evidence
            : null;
        },
      },
      signal,
    );
    if (!product) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.MATERIAL_MISSING");
    }
    return product;
  }

  private async collected(input: MarketplaceProduct) {
    const rows = await this.deps.database.query<CollectedRow>(MARKETPLACE_COLLECTION, [
      input.runId,
      input.sourceId,
      input.variantId,
    ]);
    // A run with multiple distinct unassigned labels needs an explicit variant, never "first label wins".
    if (
      new Set(
        rows.map((row) => canonicalHash((row.record as { observation: unknown }).observation)),
      ).size > 1
    ) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
    }
    const row = rows[0];
    return row ? checkedCollectedProduct(row, row.operation_id) : null;
  }

  private async history(sql: string, values: unknown[]): Promise<MarketplaceHistory> {
    const rows = await this.deps.database.query<{ record: unknown; body_hash: string }>(
      sql,
      values,
    );
    const row = rows[0];
    if (!row) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.MATERIAL_MISSING");
    }
    if (rows.length > 1 || canonicalHash(row.record) !== row.body_hash) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
    }
    return History.parse(row.record);
  }
}
