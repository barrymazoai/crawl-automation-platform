import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import { PostgresProductSync } from "./postgres-product-sync.js";

// Runs against CRAWL_TEST_DATABASE_URL; all DDL/data live in a rolled-back private schema.
const connectionString = process.env["CRAWL_TEST_DATABASE_URL"];
const migration = new URL("../../../../database/v3/061_product_sync.sql", import.meta.url);
let client: Client;
let ledger: PostgresProductSync;
const asin = { channel: "amazon" as const, listingId: "B00F42FV5I", variantId: null };
const materialAt = "2026-10-12T00:00:00.000Z";
const variant = { channel: "swanson" as const, listingId: "solgar-omega-3", variantId: "123" };

describe.skipIf(!connectionString)("product sync ledger and migration 061", () => {
  beforeEach(async () => {
    client = new Client({ connectionString });
    await client.connect();
    await client.query("BEGIN");
    const schema = `product_sync_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path = ${schema}`);
    const ddl = (await readFile(migration, "utf8"))
      .replace(/^(BEGIN|COMMIT);$/gm, "")
      .replace(/^SET LOCAL search_path = public;$/m, "");
    await client.query(ddl);
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
        source_id uuid, state text, run_id uuid, created_at timestamptz, url text, follows_item_id text);
      CREATE TABLE queue_attempt(run_id uuid, item_id text, channel text, settled_at timestamptz, outcome text);
      CREATE TABLE supply_smart_brand_company(brand_id uuid PRIMARY KEY, status text);`);
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

  it("refuses a verified row without its payload and run", async () => {
    await expect(ledger.record([{ ...asin, status: "verified", materialAt }])).rejects.toThrow();
  });
});
