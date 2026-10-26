import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ListingObservation } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { PostgresListingTargets } from "./postgres-listing-targets.js";
import { PostgresProductSync } from "./postgres-product-sync.js";

// Runs against CRAWL_TEST_DATABASE_URL; all DDL/data live in a rolled-back private schema.
const connectionString = process.env["CRAWL_TEST_DATABASE_URL"];
const migrations = ["061_product_sync.sql", "067_product_sync_removed.sql"].map(
  (file) => new URL(`../../../../database/v3/${file}`, import.meta.url),
);
let client: Client;
let ledger: PostgresProductSync;
const asin = { channel: "amazon" as const, listingId: "B00F42FV5I", variantId: null };
const materialAt = "2026-10-12T00:00:00.000Z";
const variant = { channel: "swanson" as const, listingId: "solgar-omega-3", variantId: "123" };

describe.skipIf(!connectionString)("product sync ledger and migrations 061, 067", () => {
  beforeEach(async () => {
    client = new Client({ connectionString });
    await client.connect();
    await client.query("BEGIN");
    const schema = `product_sync_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path = ${schema}`);
    for (const migration of migrations) {
      const ddl = (await readFile(migration, "utf8"))
        .replace(/^(BEGIN|COMMIT);$/gm, "")
        .replace(/^SET LOCAL search_path = public;$/m, "");
      await client.query(ddl);
    }
    // reopen `enriched` reads the enrichment tables, which every crawler database has.
    await client.query(`
      CREATE TABLE product_enrichment(enrichment_id text PRIMARY KEY, protocol text);
      CREATE TABLE product_enrichment_subject(subject_id text, enrichment_id text, channel text,
        collection_operation_id text, registered_at timestamptz)`);
    const query: Queryable["query"] = async (sql, values) =>
      (await client.query(sql, [...(values ?? [])])).rows;
    ledger = new PostgresProductSync({ query });
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  it("records attempts, keeps earlier IDs and reads rows back by key (variant '' = none)", async () => {
    const hash = "a".repeat(64);
    await ledger.record([
      {
        ...asin,
        status: "sent",
        materialAt,
        payloadHash: hash,
        ingestRunId: "run-1",
        collectedOperationId: "op-1",
      },
    ]);
    await ledger.record([
      {
        ...asin,
        status: "verified",
        materialAt: new Date().toISOString(),
        payloadHash: hash,
        ingestRunId: "run-1",
        supplySmartProductId: randomUUID(),
      },
    ]);
    await ledger.record([
      { ...variant, status: "failed", materialAt, error: { code: "company_not_found" } },
    ]);
    const rows = await ledger.read([asin, variant, { ...asin, listingId: "missing" }]);
    const saved = rows.find((row) => row.listingId === asin.listingId);
    expect(saved).toMatchObject({
      status: "verified",
      variantId: null,
      collectedOperationId: "op-1",
      attempts: 1,
    });
    // A failure recorded without a send (material problem) is not an attempt.
    expect(rows.find((row) => row.variantId === "123")).toMatchObject({
      status: "failed",
      attempts: 0,
    });
    expect(rows).toHaveLength(2);
  });

  it("baseline marks only listings without a send attempt and reports the rest as skipped", async () => {
    await ledger.record([
      { ...asin, status: "sent", materialAt, payloadHash: "b".repeat(64), ingestRunId: "run-2" },
    ]);
    expect(await ledger.markPresent([asin, variant, variant])).toEqual({ marked: 1, skipped: 1 });
    expect((await ledger.read([asin]))[0]?.status).toBe("sent");
    expect(await ledger.counts()).toEqual(
      expect.arrayContaining([
        { channel: "amazon", status: "sent", count: 1 },
        { channel: "swanson", status: "present", count: 1 },
      ]),
    );
  });

  it("overview counts completed, matched-brand and pending products without reading R2", async () => {
    await client.query(`
      CREATE TABLE brand(id uuid PRIMARY KEY, name text);
      CREATE TABLE brand_source(id uuid PRIMARY KEY, brand_id uuid, channel text);
      CREATE TABLE queue_item(item_id text PRIMARY KEY, channel text, listing_id text, variant_id text,
        source_id uuid, state text, run_id uuid, created_at timestamptz, url text, follows_item_id text,
        reason text);
      CREATE TABLE queue_attempt(run_id uuid, item_id text, channel text, settled_at timestamptz, outcome text);
      CREATE TABLE supply_smart_brand_company(brand_id uuid PRIMARY KEY, status text);
      CREATE TABLE listing_state_observation(run_id uuid, state text);`);
    const [matched, waiting] = [randomUUID(), randomUUID()];
    const sources = { matched: randomUUID(), waiting: randomUUID() };
    await client.query(`INSERT INTO brand VALUES ($1, 'Matched'), ($2, 'Waiting')`, [
      matched,
      waiting,
    ]);
    await client.query(`INSERT INTO brand_source VALUES ($1, $2, 'gnc'), ($3, $4, 'gnc')`, [
      sources.matched,
      matched,
      sources.waiting,
      waiting,
    ]);
    await client.query(
      `INSERT INTO supply_smart_brand_company VALUES ($1, 'matched'), ($2, 'unmatched')`,
      [matched, waiting],
    );
    const product = async (listing: string, source: string, state = "completed") => {
      const run = randomUUID();
      await client.query(`INSERT INTO queue_item VALUES ($1, 'gnc', $1, NULL, $2, $3, $4, now())`, [
        listing,
        source,
        state,
        run,
      ]);
      await client.query(
        `INSERT INTO queue_attempt VALUES ($1, $2, 'gnc', now() - interval '1 hour', 'completed')`,
        [run, listing],
      );
    };
    await product("a", sources.matched);
    await product("b", sources.matched);
    await product("c", sources.waiting);
    await product("d", sources.matched, "review");
    // Outside supplements: completed, but neither completed for the sync nor pending (2026-10-26).
    await product("e", sources.matched);
    await client.query(
      `UPDATE queue_item SET reason = 'PRODUCT.NOT_SUPPLEMENT' WHERE item_id = 'e'`,
    );
    await ledger.record([
      {
        channel: "gnc",
        listingId: "a",
        variantId: null,
        status: "verified",
        materialAt: new Date().toISOString(),
        payloadHash: "c".repeat(64),
        ingestRunId: "r",
      },
    ]);
    expect(await ledger.overview()).toEqual([
      { channel: "gnc", completed: 3, matchedBrand: 2, pending: 1 },
    ]);
  });

  it("reopen moves matching failures before every capture and keeps the failure on record", async () => {
    await ledger.record([
      {
        ...asin,
        status: "failed",
        materialAt,
        error: { reason: "PRODUCT_DELIVERY.MATERIAL_MISSING" },
      },
      { ...variant, status: "failed", materialAt, error: { reason: "company_not_found: x" } },
    ]);
    expect(await ledger.reopen({ reason: "PRODUCT_DELIVERY.MATERIAL_MISSING", limit: 10 })).toEqual(
      { reopened: 1 },
    );
    const rows = (
      await client.query(
        "SELECT listing_id, material_at = '-infinity' AS reopened, error FROM product_sync ORDER BY listing_id",
      )
    ).rows;
    expect(rows).toEqual([
      expect.objectContaining({ listing_id: asin.listingId, reopened: true }),
      expect.objectContaining({ listing_id: variant.listingId, reopened: false }),
    ]);
    expect(rows[0].error).toEqual({ reason: "PRODUCT_DELIVERY.MATERIAL_MISSING" });
  });

  it("reopen withoutLabel picks verified products sent without a formula", async () => {
    const hash = "b".repeat(64);
    const sent = {
      status: "verified" as const,
      materialAt,
      payloadHash: hash,
      ingestRunId: "run-2",
    };
    await ledger.record([
      { ...asin, ...sent },
      { ...variant, ...sent, collectedOperationId: "op-with-formula" },
    ]);
    expect(await ledger.reopen({ withoutLabel: true, limit: 10 })).toEqual({ reopened: 1 });
    const rows = (
      await client.query(
        "SELECT listing_id, material_at = '-infinity' AS reopened FROM product_sync ORDER BY listing_id",
      )
    ).rows;
    expect(rows).toEqual([
      { listing_id: asin.listingId, reopened: true },
      { listing_id: variant.listingId, reopened: false },
    ]);
  });

  it("reopen unfinished picks only attempts left sent for over 10 minutes", async () => {
    const sent = {
      status: "sent" as const,
      materialAt,
      payloadHash: "c".repeat(64),
      ingestRunId: "run-3",
    };
    await ledger.record([
      { ...asin, ...sent },
      { ...variant, ...sent },
    ]);
    await client.query(
      "UPDATE product_sync SET updated_at = now() - interval '11 minutes' WHERE listing_id = $1",
      [asin.listingId],
    );
    expect(await ledger.reopen({ unfinished: true, limit: 10 })).toEqual({ reopened: 1 });
    const rows = (
      await client.query(
        "SELECT listing_id, material_at = '-infinity' AS reopened FROM product_sync ORDER BY listing_id",
      )
    ).rows;
    expect(rows).toEqual([
      { listing_id: asin.listingId, reopened: true },
      { listing_id: variant.listingId, reopened: false },
    ]);
  });

  it("reopen present re-pends the baseline of listings Supply Smart already had", async () => {
    await ledger.markPresent([asin]);
    const sent = {
      status: "verified" as const,
      materialAt,
      payloadHash: "e".repeat(64),
      ingestRunId: "run-5",
    };
    await ledger.record([{ ...variant, ...sent }]);
    expect(await ledger.reopen({ present: true, limit: 10 })).toEqual({ reopened: 1 });
    const rows = (
      await client.query(
        "SELECT listing_id, status, material_at = '-infinity' AS reopened FROM product_sync ORDER BY listing_id",
      )
    ).rows;
    expect(rows).toEqual([
      { listing_id: asin.listingId, status: "present", reopened: true },
      { listing_id: variant.listingId, status: "verified", reopened: false },
    ]);
  });

  it("reopen enriched re-pends verified products enriched again under the current protocol", async () => {
    const sent = (listingId: string, channel: "amazon" | "wholefoods", operation: string) => ({
      channel,
      listingId,
      variantId: null,
      status: "verified" as const,
      materialAt,
      payloadHash: "a".repeat(64),
      ingestRunId: "run-7",
      collectedOperationId: operation,
    });
    await ledger.record([
      sent("B000000001", "wholefoods", "op-new"), // its Amazon ASIN was enriched again: resent
      sent("B000000002", "amazon", "op-old"), // enriched before the send: unchanged
      sent("B000000003", "amazon", "op-v3"), // enriched again, but under an older protocol
    ]);
    await client.query(`
      INSERT INTO product_enrichment VALUES ('e-new', 'product-enrichment/4'),
        ('e-old', 'product-enrichment/4'), ('e-v3', 'product-enrichment/3');
      INSERT INTO product_enrichment_subject VALUES
        ('s1', 'e-new', 'amazon', 'op-new', now() + interval '1 hour'),
        ('s2', 'e-old', 'amazon', 'op-old', now() - interval '1 hour'),
        ('s3', 'e-v3', 'amazon', 'op-v3', now() + interval '1 hour')`);
    expect(await ledger.reopen({ enriched: true, limit: 10 })).toEqual({ reopened: 1 });
    const rows = (
      await client.query(
        "SELECT listing_id FROM product_sync WHERE material_at = '-infinity' ORDER BY listing_id",
      )
    ).rows;
    expect(rows).toEqual([{ listing_id: "B000000001" }]);
  });

  it("a delisting covers every ID its listing was synced under", async () => {
    const sent = {
      status: "verified" as const,
      materialAt,
      payloadHash: "d".repeat(64),
      ingestRunId: "run-4",
    };
    await ledger.record([
      { channel: "costco", listingId: "100018793", variantId: "382521", ...sent },
      { channel: "costco", listingId: "100018793", variantId: "1155942", ...sent },
      { ...asin, ...sent },
    ]);
    const page = { channel: "costco" as const, listingId: "100018793" };
    const sightings = [
      { observationId: "costco-page", ...page, variantId: null },
      { observationId: "costco-variant", ...page, variantId: "382521" },
      { observationId: "amazon", ...asin },
      {
        observationId: "never-synced",
        channel: "gnc" as const,
        listingId: "444776",
        variantId: null,
      },
    ] as ListingObservation[];
    const targets = new PostgresListingTargets({
      query: async (sql, values) => (await client.query(sql, [...(values ?? [])])).rows,
    });
    const ids = await targets.externalIds(sightings);
    expect(ids.get("costco-page")?.toSorted()).toEqual(["1155942", "382521"]);
    expect(ids.get("costco-variant")).toEqual(["382521"]);
    expect(ids.get("amazon")).toEqual([asin.listingId]);
    expect(ids.get("never-synced")).toEqual(["444776"]);
  });

  it("lists delivered products outside supplements by their latest queue item, a page at a time", async () => {
    await client.query(`
      CREATE TABLE queue_item(item_id text PRIMARY KEY, channel text, listing_id text, variant_id text,
        reason text, created_at timestamptz)`);
    // whey: judged a supplement by a later capture, so not a candidate; never-sent: no Supply Smart product.
    await client.query(`INSERT INTO queue_item VALUES
      ('socks', 'gnc', '574389', NULL, 'PRODUCT.NOT_SUPPLEMENT', now()),
      ('shaker-1', 'gnc', '610673', 'black', 'PRODUCT.NOT_SUPPLEMENT', now()),
      ('shaker-2', 'gnc', '610673', 'white', 'PRODUCT.NOT_SUPPLEMENT', now()),
      ('whey-old', 'gnc', '533916', NULL, 'PRODUCT.NOT_SUPPLEMENT', now() - interval '2 days'),
      ('whey-new', 'gnc', '533916', NULL, NULL, now()),
      ('never-sent', 'gnc', '604899', NULL, 'PRODUCT.NOT_SUPPLEMENT', now())`);
    const [socks, shaker] = [randomUUID(), randomUUID()];
    const sent = (listingId: string, variantId: string | null, product: string | null) => ({
      channel: "gnc" as const,
      listingId,
      variantId,
      status: "verified" as const,
      materialAt,
      payloadHash: "f".repeat(64),
      ingestRunId: "run-6",
      ...(product ? { supplySmartProductId: product, supplySmartListingId: randomUUID() } : {}),
    });
    await ledger.record([
      sent("574389", null, socks),
      sent("610673", "black", shaker),
      sent("610673", "white", shaker),
      sent("533916", null, randomUUID()),
      sent("604899", null, null),
    ]);
    const first = await ledger.notSupplementsDelivered({ channel: "gnc", limit: 2 });
    expect(first.map((row) => [row.listingId, row.variantId])).toEqual([
      ["574389", null],
      ["610673", "black"],
    ]);
    expect(first[0]).toMatchObject({ supplySmartProductId: socks, productRemoved: false });
    // Removing one variant's product marks the other variant row as pointing at a removed product.
    await ledger.markRemoved({ channel: "gnc", listingId: "610673", variantId: "black" });
    const rest = await ledger.notSupplementsDelivered({
      channel: "gnc",
      after: { channel: "gnc", listingId: "574389", variantId: null },
      limit: 10,
    });
    expect(rest).toEqual([
      expect.objectContaining({ listingId: "610673", variantId: "white", productRemoved: true }),
    ]);
    // The removed row keeps its material time and product ID.
    const [row] = (
      await client.query(
        `SELECT status, material_at = $1::timestamptz AS same_material, supply_smart_product_id::text
         FROM product_sync WHERE variant_key = 'black'`,
        [materialAt],
      )
    ).rows;
    expect(row).toEqual({
      status: "removed",
      same_material: true,
      supply_smart_product_id: shaker,
    });
  });

  it("refuses a verified row without its payload and run", async () => {
    await expect(ledger.record([{ ...asin, status: "verified", materialAt }])).rejects.toThrow();
  });
});
