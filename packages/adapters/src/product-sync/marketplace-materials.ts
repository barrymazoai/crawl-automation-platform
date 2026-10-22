import {
  canonicalHash,
  FormulaLookup,
  formulaFamilies,
  productDeliveryErrors,
} from "@crawl-automation/app";
import {
  MARKETPLACE_CHANNELS,
  type MarketplaceHistory,
  type MarketplaceProduct,
} from "@crawl-automation/app/marketplace-mapping";
import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";
import { checkedCollectedProduct } from "../postgres/postgres-collected-products.js";
import { PostgresFormulaIndex } from "../postgres/postgres-formula-index.js";
import { deliveryEnrichment } from "../product-delivery/delivery-enrichment.js";
import { marketplaceProjection } from "./marketplace-projection.js";
import { marketplaceHistory } from "./marketplace-history.js";
import type { ListingDateDependencies } from "./marketplace-listing-date.js";
import { MARKETPLACE_COLLECTION, MARKETPLACE_LINKED_COLLECTION } from "./marketplace-queries.js";

export interface MarketplaceReaderDependencies extends ListingDateDependencies {
  database: Queryable;
}
interface CollectedRow {
  operation_id: string;
  observation_id: string;
  record_hash: string;
  record: unknown;
}

export class MarketplaceMaterials {
  constructor(private readonly deps: MarketplaceReaderDependencies) {}

  async read(input: MarketplaceProduct, signal: AbortSignal): Promise<MarketplaceProduct> {
    const history = await marketplaceHistory(this.deps.database, input);
    const collection = await this.collected(input);
    const enrichment = collection
      ? await deliveryEnrichment(this.deps.database, collection, input.channel)
      : null;
    const projection = await marketplaceProjection(
      this.deps,
      { history, collection, enrichment, channel: input.channel },
      signal,
    );
    const own = { ...input, history, collection, enrichment, ...projection };
    return collection ? own : this.withKnownFormula(own);
  }

  private async withKnownFormula(
    input: MarketplaceProduct & {
      history: MarketplaceHistory;
      product: NonNullable<MarketplaceProduct["product"]>;
    },
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
    const donor = await this.donor(known.operationId, families.channels(input.channel));
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
        channel: donor.channel,
        capturedAt: donor.collectedAt,
      },
    };
  }

  /**
   * The formula index already ties this formula to the product; the formula record's own hash is still checked.
   * Its capture page is not needed: formulas from before capture history (Amazon 09-14…09-28) have none
   * (owner 2026-10-12: always send the product's one formula).
   */
  private async donor(operationId: string, channels: string[]) {
    const rows = await this.deps.database.query<
      CollectedRow & { channel: string; collected_at: Date | string }
    >(MARKETPLACE_LINKED_COLLECTION, [operationId]);
    const row = rows[0];
    if (!row || !channels.includes(row.channel)) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
    }
    const collection = checkedCollectedProduct(row, operationId);
    const channel = z.enum(MARKETPLACE_CHANNELS).parse(row.channel);
    const enrichment = await deliveryEnrichment(this.deps.database, collection, channel);
    const collectedAt = new Date(row.collected_at).toISOString();
    return { collection, channel, collectedAt, enrichment };
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
}
