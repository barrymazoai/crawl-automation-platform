import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, it } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import {
  marketplaceItem,
  marketplaceLabel,
  type MarketplaceProduct,
} from "@crawl-automation/app/marketplace-mapping";
import { PostgresMarketplaceReader } from "./marketplace-reader.js";
import {
  readerChannels,
  readerSamples,
  readerSamplesPath,
  readerTables,
  seedReaderSample,
} from "./marketplace-reader.fixture.js";

const connectionString = process.env["CRAWL_TEST_DATABASE_URL"];
const signal = () => new AbortController().signal;
const mapping = { domain: "matched-brand.example", runId: "test-partial-batch" };

it.skipIf(!connectionString || !readerSamplesPath)(
  "resolves previous-run collections and formula_link via the pipeline index with exact captured owner identity",
  async () => {
    const client = new Client({ connectionString });
    await client.connect();
    const schema = `marketplace_formula_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path=${schema}`);
      await client.query(readerTables);
      const objects = new Map<string, Uint8Array>();
      const query: Queryable["query"] = async (sql, values) =>
        (await client.query(sql, [...(values ?? [])])).rows;
      const reader = new PostgresMarketplaceReader({
        database: { query },
        objects: { read: async (key) => objects.get(key) ?? null },
        channels: readerChannels,
      });
      const samples = readerSamples();
      for (const channel of ["amazon", "gnc", "costco", "swanson"] as const) {
        const donor = required(samples.find((entry) => entry.channel === channel));
        await seedReaderSample(client, donor, objects);
        const target = newerCapture(donor);
        await seedReaderSample(client, target, objects);
        await client.query(
          "UPDATE queue_item SET created_at = now() + interval '1 minute' WHERE item_id = $1",
          [target.runId],
        );
        const page = await reader.read({ channel, limit: 200 }, signal());
        expect(page.products).toHaveLength(1);
        const input = required(page.products[0]);
        expect(input.problem).toBeUndefined();
        expect(input.runId).toBe(target.runId);
        expect(input.collection?.operationId).toBe(donor.collection?.operationId);
        expect(input.linkedLabel?.target).toEqual({
          listingId: required(donor.product).listingId,
          variantId: required(donor.product).variantId,
        });
        // The formula's collection time, not its capture page (owner 2026-10-12).
        const collected = await client.query<{ at: Date }>(
          "SELECT collected_at AS at FROM collected_product WHERE operation_id = $1",
          [donor.collection?.operationId],
        );
        expect(marketplaceLabel(input, mapping)?.observation.capturedAt).toBe(
          required(collected.rows[0]).at.toISOString(),
        );
        expect(marketplaceItem(input, mapping).price).toBe("9.99");
        if (channel === "swanson") {
          await siblingFormula({ client, reader, objects }, donor);
        }
      }
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);

async function siblingFormula(
  fixture: { client: Client; reader: PostgresMarketplaceReader; objects: Map<string, Uint8Array> },
  donor: MarketplaceProduct,
) {
  const { client, reader, objects } = fixture;
  const target = newerCapture(donor);
  target.variantId = "explicit-sibling-variant";
  required(target.history).capture.variantId = target.variantId;
  required(target.product).variantId = target.variantId;
  await seedReaderSample(client, target, objects);
  const read = async () =>
    required(
      (await reader.read({ channel: "swanson", limit: 200 }, signal())).products.find(
        (entry) => entry.variantId === target.variantId,
      ),
    );
  // A collection for the default variant must not match another selected variant.
  expect(marketplaceLabel(await read(), mapping)).toBeNull();
  await client.query("INSERT INTO formula_link VALUES ('swanson',$1,$2,$3,now())", [
    required(target.product).listingId,
    target.variantId,
    required(donor.collection).operationId,
  ]);
  const linked = await read();
  expect(linked.problem).toBeUndefined();
  expect(linked.collection?.operationId).toBe(donor.collection?.operationId);
  expect(linked.enrichment).toBeNull();
  const label = required(marketplaceLabel(linked, mapping));
  expect(label.observation.variantId).toBe(target.variantId);
  expect(label.listing.externalId).toBe(target.variantId);
  expect(label.listing).not.toHaveProperty("price");
  expect(label.listing.extras?.["labelSource"]).toMatchObject({
    observation: donor.collection?.observation,
  });
}

function newerCapture(donor: MarketplaceProduct) {
  const target = structuredClone(donor);
  target.runId = randomUUID();
  target.sourceId = randomUUID();
  target.collection = null;
  target.enrichment = null;
  const history = required(target.history);
  history.owner.runId = target.runId;
  history.owner.sourceId = target.sourceId;
  history.owner.operationId = `product-${target.runId}`;
  history.observationId = history.owner.operationId;
  history.capturedAt = "2026-10-12T06:00:00.000Z";
  history.metrics = { price: "9.99" };
  return target;
}
function required<Value>(value: Value | null | undefined): Value {
  if (value == null) {
    throw new Error("Missing integration fixture value");
  }
  return value;
}
