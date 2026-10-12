import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, it } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import {
  marketplaceItem,
  marketplaceLabel,
  MARKETPLACE_CHANNELS,
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
  "pages real marketplace rows, joins exact retained materials, and never revives an older attempt",
  async () => {
    const client = new Client({ connectionString });
    await client.connect();
    const schema = `marketplace_reader_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path=${schema}`);
      await client.query(readerTables);
      const objects = new Map<string, Uint8Array>();
      const inputs = readerSamples();
      for (const input of inputs) {
        await seedReaderSample(client, input, objects);
      }
      const query: Queryable["query"] = async (sql, values) =>
        (await client.query(sql, [...(values ?? [])])).rows;
      const reader = new PostgresMarketplaceReader({
        database: { query },
        objects: { read: async (key) => objects.get(key) ?? null },
        channels: readerChannels,
      });
      for (const channel of MARKETPLACE_CHANNELS) {
        const first = await reader.read({ channel, limit: 2 }, signal());
        expect(first.products).toHaveLength(2);
        expect(first.after).not.toBeNull();
        const second = await reader.read(
          { channel, limit: 2, after: required(first.after) },
          signal(),
        );
        expect(second.products).toHaveLength(1);
        expect(second.after).toBeNull();
        const products = [...first.products, ...second.products];
        expect(new Set(products.map((entry) => entry.listingId)).size).toBe(3);
        for (const product of products) {
          verifyRealMaterial(product);
        }
      }
      await pendingOnly(client, reader);
      await followerUsesLeaderMaterial(client, reader);
      await rejectsLatestStates(client, reader);
      await wholeFoodsJoin(client, reader, { inputs, objects });
      // One corrupt archive cannot abort the page or trap its cursor.
      const broken = required(inputs.find((entry) => entry.listingId === "424743"));
      const ref = required(broken.enrichment?.subject.titleEvidence);
      objects.set(ref.sourceId, Buffer.from("corrupt retained bytes"));
      const gnc = await reader.read({ channel: "gnc", limit: 200 }, signal());
      expect(gnc.products.find((entry) => entry.listingId === "424743")?.problem).toBe(
        "PRODUCT_DELIVERY.INTEGRITY",
      );
      expect(gnc.products.filter((entry) => !entry.problem)).toHaveLength(2);
      await expect(reader.read({ channel: "gnc", limit: 201 }, signal())).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);

/**
 * The sweep reads only matched brands' products not synced since their latest settlement (migrations 060/061).
 * Rows stay for the rest of the test (rolled back); later reads do not use `pending`.
 */
async function pendingOnly(client: Client, reader: PostgresMarketplaceReader) {
  const read = async () =>
    (await reader.read({ channel: "gnc", limit: 200, pending: true }, signal())).products.map(
      (entry) => entry.listingId,
    );
  expect(await read()).toEqual([]);
  await client.query(
    `INSERT INTO supply_smart_brand_company SELECT DISTINCT s.brand_id, 'matched'
     FROM brand_source s WHERE s.channel = 'gnc'`,
  );
  const all = await read();
  expect(all).toHaveLength(3);
  // The watermark round-trips exactly: an outcome recorded with the reader's materialAt hides that very capture.
  const [first] = (await reader.read({ channel: "gnc", limit: 1, pending: true }, signal()))
    .products;
  // PostgreSQL trims trailing zeros (.242410 -> .24241); what matters is the exact round trip below.
  expect(required(first).materialAt).toMatch(/\.\d+/u);
  await client.query(
    `INSERT INTO product_sync VALUES ('gnc', $1, '', 'verified', $2::timestamptz)`,
    [required(first).listingId, required(first).materialAt],
  );
  expect(await read()).not.toContain(required(first).listingId);
  await client.query(`UPDATE product_sync SET status = 'waiting_company' WHERE listing_id = $1`, [
    required(first).listingId,
  ]);
  // Newer outcomes hide the capture they were recorded against; an older baseline does not hide a newer capture.
  // The last column is material_at: which capture each row covers.
  await client.query(
    `INSERT INTO product_sync VALUES ('gnc', $1, '', 'verified', now() + interval '1 day'),
       ('gnc', $2, '', 'present', now() + interval '1 day'),
       ('gnc', $3, '', 'present', now() - interval '10 years')`,
    [all[0], all[1], all[2]],
  );
  expect(await read()).toEqual([all[2]]);
}

function verifyRealMaterial(product: MarketplaceProduct) {
  if (product.listingId === "4000349261") {
    expect(product.problem).toBe("PRODUCT_DELIVERY.MATERIAL_MISSING");
    return;
  }
  expect(product.problem).toBeUndefined();
  const item = marketplaceItem(product, mapping);
  expect(item).not.toHaveProperty("siteKey");
  if (product.channel === "wholefoods") {
    expect(product.collection).toBeNull();
    expect(item.inStock).toBe(false);
    expect(marketplaceLabel(product, mapping)).toBeNull();
  } else {
    expect(required(product.enrichment).subject.collectionOperationId).toBe(
      required(product.collection).operationId,
    );
    expect(marketplaceLabel(product, mapping)?.label.content.formula).toEqual(
      required(product.collection).formula,
    );
  }
}
/** A follower on another source shares its leader's run; the archives are the leader's (review 2026-10-12). */
async function followerUsesLeaderMaterial(client: Client, reader: PostgresMarketplaceReader) {
  const leader = (
    await client.query(
      "SELECT item_id, source_id::text FROM queue_item WHERE channel = 'gnc' AND listing_id = '452410'",
    )
  ).rows[0];
  const followerSource = randomUUID();
  await client.query(
    `INSERT INTO brand_source SELECT $1, channel, brand_id FROM brand_source WHERE id = $2`,
    [followerSource, leader.source_id],
  );
  await client.query(
    `INSERT INTO queue_item SELECT 'follower-452410', $1, channel, listing_id, variant_id, url, 'completed',
       run_id, now() + interval '1 minute', item_id FROM queue_item WHERE item_id = $2`,
    [followerSource, leader.item_id],
  );
  const page = await reader.read({ channel: "gnc", limit: 200 }, signal());
  const product = required(page.products.find((entry) => entry.listingId === "452410"));
  expect(product).toMatchObject({ queueId: "follower-452410", sourceId: leader.source_id });
  expect(product.problem).toBeUndefined();
  // Make the leader the latest row again for the checks that follow.
  await client.query(
    "UPDATE queue_item SET created_at = now() - interval '1 day' WHERE item_id = 'follower-452410'",
  );
}

async function rejectsLatestStates(client: Client, reader: PostgresMarketplaceReader) {
  // A newer queue row on another source still supersedes the old marketplace listing.
  await client.query(
    `INSERT INTO queue_item SELECT 'new-review',source_id,channel,listing_id,variant_id,url,
    'review',$1,now()+interval '1 minute' FROM queue_item WHERE listing_id='B00F42FV5I'`,
    [randomUUID()],
  );
  await client.query(
    "UPDATE queue_attempt SET settled_at=NULL WHERE item_id=(SELECT item_id FROM queue_item WHERE listing_id='B00551W73C')",
  );
  await client.query(
    "UPDATE queue_attempt SET outcome='review' WHERE item_id=(SELECT item_id FROM queue_item WHERE listing_id='B0FFTMHSMC')",
  );
  expect((await reader.read({ channel: "amazon", limit: 200 }, signal())).products).toEqual([]);
  // Restore the exact donor's settled receipt for the same-ASIN Whole Foods test.
  await client.query(
    "UPDATE queue_attempt SET settled_at=now() WHERE item_id=(SELECT item_id FROM queue_item WHERE listing_id='B00551W73C')",
  );
}
async function wholeFoodsJoin(
  client: Client,
  reader: PostgresMarketplaceReader,
  fixture: { inputs: MarketplaceProduct[]; objects: Map<string, Uint8Array> },
) {
  const { inputs, objects } = fixture;
  const donor = required(inputs.find((entry) => entry.listingId === "B00551W73C"));
  const target = structuredClone(required(inputs.find((entry) => entry.channel === "wholefoods")));
  target.runId = randomUUID();
  target.listingId = donor.listingId;
  target.url = `https://www.wholefoodsmarket.com/grocery/product/product-${target.listingId.toLowerCase()}`;
  const history = required(target.history);
  history.owner.runId = target.runId;
  history.observationId = `product-${target.runId}`;
  history.listing.externalId = target.listingId;
  history.listing.url = target.url;
  const projection = required(target.product);
  projection.listingId = target.listingId;
  projection.url = target.url;
  await seedReaderSample(client, target, objects);
  const page = await reader.read({ channel: "wholefoods", limit: 200 }, signal());
  const linked = required(page.products.find((entry) => entry.listingId === donor.listingId));
  expect(linked.collection?.operationId).toBe(donor.collection?.operationId);
  expect(linked.history?.listing.channel).toBe("wholefoods");
  expect(linked.linkedLabel?.channel).toBe("amazon");
  expect(linked.product?.channel).toBe("wholefoods");
  expect(marketplaceItem(linked, mapping).inStock).toBe(false);
  // The formula's own collection time; its capture page is not required.
  const capturedAt = required(linked.linkedLabel).capturedAt;
  expect(marketplaceLabel(linked, mapping)?.observation.capturedAt).toBe(capturedAt);
}
function required<Value>(value: Value | null | undefined): Value {
  if (value == null) {
    throw new Error("Missing integration fixture value");
  }
  return value;
}
