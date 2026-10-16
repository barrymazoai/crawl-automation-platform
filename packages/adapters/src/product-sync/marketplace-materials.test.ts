import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalHash } from "@crawl-automation/app";
import {
  marketplaceItem,
  marketplaceLabel,
  type MarketplaceProduct,
} from "@crawl-automation/app/marketplace-mapping";
import type { Queryable } from "@crawl-automation/platform";
import { labelCollectedHash } from "@crawl-automation/processing";
import { MarketplaceMaterials } from "./marketplace-materials.js";
import {
  MARKETPLACE_COLLECTION,
  MARKETPLACE_HISTORY,
  MARKETPLACE_LINKED_COLLECTION,
} from "./marketplace-queries.js";
import { readerChannels, readerSamples, readerSamplesPath } from "./marketplace-reader.fixture.js";

const samples = readerSamples();
const options = { domain: "matched-brand.example", runId: "partial-sync" };
const signal = () => new AbortController().signal;
/** When the donor formula was collected (collected_product.collected_at). */
const COLLECTED_AT = "2026-09-20T10:00:00.000Z";
const sample = (channel: MarketplaceProduct["channel"]) =>
  structuredClone(required(samples.find((entry) => entry.channel === channel)));

// Real collected records with controlled later captures and projection doubles, not new live observations.
function setup(channel: MarketplaceProduct["channel"] = "gnc") {
  const donor = sample(channel === "wholefoods" ? "amazon" : channel);
  const target = structuredClone(donor);
  target.channel = channel;
  target.runId = randomUUID();
  target.sourceId = randomUUID();
  const history = required(target.history);
  history.owner.runId = target.runId;
  history.owner.sourceId = target.sourceId;
  history.observationId = `product-${target.runId}`;
  history.capturedAt = "2026-10-12T06:00:00.000Z";
  history.listing.channel = channel;
  history.metrics = { price: "9.99", inStock: false };
  const product = required(target.product);
  product.channel = channel;
  product.title = "Current capture title";
  target.collection = null;
  target.enrichment = null;
  const objects = new Map<string, Uint8Array>();
  const retained = (
    input: MarketplaceProduct,
    bytes = Buffer.from(JSON.stringify(input.product)),
  ) => {
    const objectKey = `fixture/${input.runId}`;
    objects.set(objectKey, bytes);
    required(input.history).evidence = [
      { objectKey, sha256: createHash("sha256").update(bytes).digest("hex") },
    ];
  };
  retained(target);
  retained(donor);
  const collection = required(donor.collection);
  const state = {
    known: true,
    own: false,
    collectionHash: labelCollectedHash(collection),
    historyHash: null as string | null,
  };
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) =>
    rows(sql, values, { donor, target, state }),
  );
  const deps = {
    database: { query } as Queryable,
    objects: { read: async (key: string) => objects.get(key) ?? null },
    channels: readerChannels,
  };
  return {
    donor,
    target,
    objects,
    retained,
    state,
    query,
    deps,
    read: () => new MarketplaceMaterials(deps).read(target, signal()),
  };
}
function rows(
  sql: string,
  values: readonly unknown[] | undefined,
  fixture: {
    donor: MarketplaceProduct;
    target: MarketplaceProduct;
    state: {
      known: boolean;
      own: boolean;
      collectionHash: string;
      historyHash: string | null;
    };
  },
) {
  const { donor, target, state } = fixture;
  const collection = required(donor.collection);
  const row = {
    operation_id: collection.operationId,
    observation_id: collection.observation.observationId,
    record_hash: state.collectionHash,
    record: collection,
    channel: donor.channel,
    collected_at: new Date(COLLECTED_AT),
  };
  if (sql === MARKETPLACE_HISTORY) {
    const record = required(target.history);
    return [{ record, body_hash: state.historyHash ?? canonicalHash(record) }];
  }
  if (sql === MARKETPLACE_COLLECTION) {
    return state.own ? [row] : [];
  }
  if (sql === MARKETPLACE_LINKED_COLLECTION) {
    return [row];
  }
  if (sql.includes(") known")) {
    assertLookup(values, target);
    return state.known ? [{ operation_id: collection.operationId }] : [];
  }
  if (sql.includes("product_enrichment_subject")) {
    return [];
  }
  throw new Error(`Unexpected SQL: ${sql}`);
}
function assertLookup(values: readonly unknown[] | undefined, target: MarketplaceProduct) {
  const product = required(target.product);
  expect(values).toEqual([
    target.channel === "wholefoods" || target.channel === "amazon"
      ? ["amazon", "wholefoods"]
      : [target.channel],
    product.listingId,
    product.variantId,
  ]);
}
function required<Value>(value: Value | null | undefined): Value {
  if (value == null) {
    throw new Error("Missing fixture value");
  }
  return value;
}

describe.skipIf(!readerSamplesPath)(
  "formula-once marketplace materials (real records, database/object doubles)",
  () => {
    for (const channel of ["amazon", "gnc", "costco", "swanson", "wholefoods"] as const) {
      it(`${channel}: resolves a missing collection from the parsed owner across its formula family`, async () => {
        const fixture = setup(channel);
        const input = await fixture.read();
        const label = required(marketplaceLabel(input, options));
        expect(input.collection).toEqual(fixture.donor.collection);
        expect(input.linkedLabel?.channel).toBe(fixture.donor.channel);
        expect(label.observation.capturedAt).toBe(COLLECTED_AT);
        // The formula index is the link: the donor's capture history is never read.
        expect(
          fixture.query.mock.calls.filter(([sql]) => sql === MARKETPLACE_HISTORY),
        ).toHaveLength(1);
        expect(label.listing).not.toHaveProperty("price");
        expect(label.listing).not.toHaveProperty("inStock");
        expect(marketplaceItem(input, options)).toMatchObject({
          price: "9.99",
          inStock: false,
          titleRaw: "Current capture title",
          capturedAt: fixture.target.history?.capturedAt,
        });
        expect(label).toEqual(marketplaceLabel(input, { ...options, runId: "other-sync" }));
        expect(label.submitter.operationId).not.toBe(
          required(marketplaceLabel(fixture.donor, options)).submitter.operationId,
        );
        const later = structuredClone(input);
        required(later.history).observationId += "-later";
        expect(marketplaceLabel(later, options)?.submitter.operationId).not.toBe(
          label.submitter.operationId,
        );
      });
    }
    it("Swanson recovers the numeric owner from its own retained original, never its handle or history SKU", async () => {
      const fixture = setup("swanson");
      fixture.retained(
        fixture.target,
        Buffer.from("<html>Explicit retained-page parser input double</html>"),
      );
      const evidence = required(fixture.target.product);
      const parseProduct = vi.fn(() => ({
        evidence,
        channel: fixture.target.channel,
        identity: { listingId: evidence.listingId, variantId: evidence.variantId },
        rendered: {},
        commerce: null,
        variants: [],
        facts: { complete: false, text: null, missing: [] },
      }));
      fixture.deps.channels = {
        ...readerChannels,
        get: (channel) => ({ ...readerChannels.get(channel), parseProduct }),
      };
      const input = await fixture.read();
      expect(parseProduct).toHaveBeenCalledWith({
        html: "<html>Explicit retained-page parser input double</html>",
        url: fixture.target.history?.listing.url,
        capturedAt: fixture.target.history?.capturedAt,
      });
      expect(input.linkedLabel?.target).toEqual({
        listingId: "8572216246410",
        variantId: "46318742077578",
      });
      expect(input.listingId).toBe("country-life-core-daily-1-women-50-60-tabs");
      expect(input.history?.listing.externalId).toBe("CRL530");
    });
    it("a formula_link may point at a sibling's collection, while the label and commerce target the captured variant", async () => {
      const fixture = setup("swanson");
      required(fixture.target.product).variantId = "explicit-sibling-variant";
      fixture.retained(fixture.target);
      const input = await fixture.read();
      const label = required(marketplaceLabel(input, options));
      expect(label.observation.variantId).toBe("explicit-sibling-variant");
      expect(label.listing.externalId).toBe("explicit-sibling-variant");
      expect(label.listing.extras?.["labelSource"]).toMatchObject({
        observation: fixture.donor.collection?.observation,
      });
      expect(input.enrichment).toBeNull();
      expect(input.product).toEqual(fixture.target.product);
    });
    it("preserves a true absence and prefers the current run's own collection", async () => {
      const absent = setup();
      absent.state.known = false;
      expect(marketplaceLabel(await absent.read(), options)).toBeNull();
      const own = setup();
      own.state.own = true;
      own.target.runId = own.donor.runId;
      own.target.sourceId = own.donor.sourceId;
      own.target.history = structuredClone(own.donor.history);
      own.target.product = structuredClone(own.donor.product);
      own.retained(own.target);
      const input = await own.read();
      expect(input.linkedLabel).toBeUndefined();
      expect(marketplaceLabel(input, options)?.observation.observationId).toBe(
        `${own.donor.collection?.observation.observationId}-confidence-1`,
      );
      expect(own.query.mock.calls.some(([sql]) => sql.includes(") known"))).toBe(false);
    });
    it("sends the formula when it predates capture history and its page is gone", async () => {
      const fixture = setup("swanson");
      fixture.objects.delete(required(required(fixture.donor.history).evidence[0]).objectKey);
      const input = await fixture.read();
      expect(input.product).toEqual(fixture.target.product);
      expect(input.collection).toEqual(fixture.donor.collection);
      expect(required(marketplaceLabel(input, options)).observation.capturedAt).toBe(COLLECTED_AT);
      expect(marketplaceItem(input, options)).toMatchObject({
        titleRaw: "Current capture title",
        price: "9.99",
        inStock: false,
      });
    });
    it("still refuses a missing own page", async () => {
      const missing = setup("swanson");
      missing.objects.delete(required(required(missing.target.history).evidence[0]).objectKey);
      await expect(missing.read()).rejects.toMatchObject({
        code: "PRODUCT_DELIVERY.MATERIAL_MISSING",
      });
      expect(missing.query.mock.calls.some(([sql]) => sql.includes(") known"))).toBe(false);
    });
    it("rejects corrupt donor records, target histories and target retained bytes", async () => {
      const corruptCollection = setup();
      corruptCollection.state.collectionHash = "bad";
      await expect(corruptCollection.read()).rejects.toThrow();
      const badHistoryHash = setup();
      badHistoryHash.state.historyHash = "bad";
      await expect(badHistoryHash.read()).rejects.toThrow(/hash or SKU owner/u);
      const corruptBytes = setup();
      corruptBytes.objects.set(
        required(required(corruptBytes.target.history).evidence[0]).objectKey,
        Buffer.from("bad"),
      );
      await expect(corruptBytes.read()).rejects.toThrow(/hash or SKU owner/u);
    });
    it("rejects a relinked target even when record hashes are valid", async () => {
      const valid = await setup().read();
      required(valid.linkedLabel).target.variantId = "foreign";
      expect(() => marketplaceLabel(valid, options)).toThrow(/hash or SKU owner/u);
    });
  },
);
