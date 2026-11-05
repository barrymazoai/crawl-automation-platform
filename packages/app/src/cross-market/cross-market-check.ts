import {
  AMAZON_CHANNELS,
  AMAZON_MARKETPLACES,
  CrossMarketFieldSchema,
  isAmazonChannel,
  type AmazonChannel,
  type CrossMarketField,
  type CrossMarketListing,
  type LabelCollectedProduct,
} from "@crawl-automation/v3-contracts";
import type { MarketplaceProduct } from "../product-sync/marketplace-model.js";
import { crossMarketSide } from "./cross-market-side.js";
import type {
  CrossMarketJudge,
  CrossMarketKey,
  CrossMarketListings,
  CrossMarketMaterial,
  CrossMarketRecapture,
  CrossMarketRecord,
  CrossMarketRecords,
} from "./ports.js";
import { sameFormula } from "./same-formula.js";

/** How long a listing waits for the other storefront's recaptured page before it is sent without a verdict. */
export const MATERIAL_WAIT_MS = 3 * 24 * 60 * 60 * 1000;

/** What a product's delivery carries: a verdict, nothing (no listing elsewhere, or no judgment), or a wait. */
export type CrossMarketOutcome =
  { field: CrossMarketField } | { none: true } | { hold: "material" | "judgment" };

type Decision =
  { field: CrossMarketField } | { hold: "material" | "judgment" } | { unjudged: string };
type Checked = MarketplaceProduct & { channel: AmazonChannel; collection: LabelCollectedProduct };
interface Pending {
  product: Checked;
  key: CrossMarketKey;
  comparedWith: CrossMarketField["comparedWith"];
  pendingSince: string | null;
}

export interface CrossMarketDeps {
  listings: CrossMarketListings;
  material: CrossMarketMaterial;
  judge: CrossMarketJudge;
  records: CrossMarketRecords;
  recapture: CrossMarketRecapture;
  now?: () => Date;
  /** Where a failed judgment is reported (the listing itself waits for the next round). */
  log?: (error: unknown) => void;
}

const checkable = (product: MarketplaceProduct): product is Checked =>
  isAmazonChannel(product.channel) && !!product.collection;

/**
 * KAN-243 (owner 2026-11-05, plan B): before an Amazon storefront's listing is first sent, whether the same ASIN's
 * listing on another storefront in Supply Smart is the same product. The crawler compares its own collected labels of
 * both: the same rows and serving size are `same` by rule, anything else is the label model's judgment. Without the
 * other storefront's material, its page is queued once and the listing waits for it (at most MATERIAL_WAIT_MS).
 * Without any judgment possible the listing is sent with no verdict (Supply Smart's default) and the reason is kept.
 */
export class CrossMarketCheck {
  constructor(private readonly deps: CrossMarketDeps) {}

  async outcomes(products: MarketplaceProduct[], signal: AbortSignal) {
    const checked = products.filter(checkable);
    const ids = [...new Set(checked.map((product) => product.listingId))];
    const listings = ids.length ? await this.deps.listings.lookup(ids, signal) : new Map();
    const outcomes = new Map<MarketplaceProduct, CrossMarketOutcome>();
    for (const product of checked) {
      outcomes.set(
        product,
        await this.outcome(product, listings.get(product.listingId) ?? [], signal),
      );
    }
    return outcomes;
  }

  private async outcome(
    product: Checked,
    listings: CrossMarketListing[],
    signal: AbortSignal,
  ): Promise<CrossMarketOutcome> {
    const own = AMAZON_MARKETPLACES[product.channel].countryCode;
    const compared = listings.find((listing) => listing.countryCode !== own);
    if (!compared) {
      return { none: true };
    }
    const key: CrossMarketKey = {
      channel: product.channel,
      listingId: product.listingId,
      collectionOperationId: product.collection.operationId,
      comparedListingId: compared.listingId,
    };
    const prior = await this.deps.records.latest(key);
    if (prior?.status === "decided") {
      return { field: prior.field };
    }
    if (prior?.status === "unjudged") {
      return { none: true };
    }
    const comparedWith = {
      listingId: compared.listingId,
      countryCode: compared.countryCode,
      externalId: product.listingId,
    };
    const pending = { product, key, comparedWith, pendingSince: prior?.recordedAt ?? null };
    return this.kept(pending, await this.decide(pending, signal));
  }

  /** A decision is recorded before it is used; a wait is recorded once, when it starts. */
  private async kept(at: Pending, decision: Decision): Promise<CrossMarketOutcome> {
    const recordedAt = this.now();
    const record: CrossMarketRecord | null =
      "field" in decision
        ? { ...at.key, status: "decided", field: decision.field, recordedAt }
        : "unjudged" in decision
          ? { ...at.key, status: "unjudged", reason: decision.unjudged, recordedAt }
          : at.pendingSince || decision.hold === "judgment"
            ? null
            : { ...at.key, status: "pending", recordedAt };
    if (record) {
      await this.deps.records.record(record);
    }
    return "unjudged" in decision ? { none: true } : decision;
  }

  private async decide(at: Pending, signal: AbortSignal): Promise<Decision> {
    const { product, comparedWith } = at;
    const otherChannel = AMAZON_CHANNELS.find(
      (channel) => AMAZON_MARKETPLACES[channel].countryCode === comparedWith.countryCode,
    );
    if (!otherChannel) {
      return { unjudged: "no_crawler_channel" };
    }
    const [other] = await this.deps.material.read(otherChannel, [product.listingId], signal);
    if (!other) {
      return this.waitForMaterial(at, otherChannel, signal);
    }
    if (!other.collection) {
      return { unjudged: "other_no_label" };
    }
    if (sameFormula(product.collection, other.collection)) {
      return this.field({
        verdict: "same",
        comparedWith,
        method: "rule",
        reasons: ["same_rows_and_serving"],
      });
    }
    // A failed model turn holds only this listing; it is judged again next round, its siblings are sent.
    const judged = await this.deps.judge
      .judge(
        {
          listing: crossMarketSide(product, product.collection),
          other: crossMarketSide(other, other.collection),
        },
        signal,
      )
      .catch((error: unknown) => {
        signal.throwIfAborted();
        this.deps.log?.(error);
        return null;
      });
    return judged ? this.field({ ...judged, comparedWith, method: "codex" }) : { hold: "judgment" };
  }

  /** The other storefront's page is queued once; past the wait, or with no source to queue it from, no verdict. */
  private async waitForMaterial(
    at: Pending,
    otherChannel: AmazonChannel,
    signal: AbortSignal,
  ): Promise<Decision> {
    const { product, pendingSince } = at;
    if (pendingSince && this.clock().getTime() - Date.parse(pendingSince) > MATERIAL_WAIT_MS) {
      return { unjudged: "other_material_unavailable" };
    }
    const requested = product.brandId
      ? await this.deps.recapture.request(
          { channel: otherChannel, listingId: product.listingId, brandId: product.brandId },
          signal,
        )
      : "no-source";
    return requested === "no-source" ? { unjudged: "no_crawler_material" } : { hold: "material" };
  }

  private field(input: Omit<CrossMarketField, "decidedAt">): { field: CrossMarketField } {
    return { field: CrossMarketFieldSchema.parse({ ...input, decidedAt: this.now() }) };
  }

  private clock(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
