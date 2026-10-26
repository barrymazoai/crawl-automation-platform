import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import { outdatedEnrichment } from "./enrichment-selection.js";
import { PostgresProductSync } from "./postgres-product-sync.js";

// Runs against CRAWL_TEST_DATABASE_URL; all DDL/data live in a rolled-back private schema.
const connectionString = process.env["CRAWL_TEST_DATABASE_URL"];
const migration = new URL("../../../../database/v3/061_product_sync.sql", import.meta.url);
const materialAt = "2026-10-12T00:00:00.000Z";
let client: Client;
let ledger: PostgresProductSync;
const query: Queryable["query"] = async (sql, values) =>
  (await client.query(sql, [...(values ?? [])])).rows;

describe.skipIf(!connectionString)("outdated enrichment selection", () => {
  beforeEach(async () => {
    client = new Client({ connectionString });
    await client.connect();
    await client.query("BEGIN");
    const schema = `outdated_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path = ${schema}`);
    await client.query(
      (await readFile(migration, "utf8"))
        .replace(/^(BEGIN|COMMIT);$/gm, "")
        .replace(/^SET LOCAL search_path = public;$/m, ""),
    );
    await client.query(`
      CREATE TABLE collected_product(operation_id text PRIMARY KEY, record jsonb);
      CREATE TABLE product_enrichment(enrichment_id text PRIMARY KEY, protocol text);
      CREATE TABLE product_enrichment_subject(subject_id text, enrichment_id text, channel text,
        collection_operation_id text, registered_at timestamptz, listing_id text, variant_id text)`);
    ledger = new PostgresProductSync({ query });
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  it("lists sent products without a current enrichment: none first, then /2, then the rest", async () => {
    const sent = (listingId: string, channel: "amazon" | "wholefoods", operation: string) => ({
      channel,
      listingId,
      variantId: null,
      status: "verified" as const,
      materialAt,
      payloadHash: "a".repeat(64),
      ingestRunId: "run-8",
      collectedOperationId: operation,
    });
    await ledger.record([
      sent("B000000004", "amazon", "op-current"),
      sent("B000000003", "amazon", "op-v3"),
      sent("B000000002", "amazon", "op-v2"),
      sent("B000000001", "wholefoods", "op-none"),
    ]);
    await client.query(`
    INSERT INTO collected_product
      SELECT op, jsonb_build_object('observation', jsonb_build_object('listingId', id, 'variantId', null))
        FROM (VALUES ('op-none', 'B000000001'), ('op-v2', 'B000000002'), ('op-v3', 'B000000003'),
                     ('op-current', 'B000000004')) AS v(op, id);
    INSERT INTO product_enrichment VALUES ('e-2', 'product-enrichment/2'), ('e-3', 'product-enrichment/3'),
      ('e-4', 'product-enrichment/4');
    INSERT INTO product_enrichment_subject VALUES
      ('s2', 'e-2', 'amazon', 'op-v2', now(), 'B000000002', null),
      -- only the latest subject counts: /4 earlier, /3 later
      ('s3a', 'e-4', 'amazon', 'op-v3', now() - interval '1 hour', 'B000000003', null),
      ('s3b', 'e-3', 'amazon', 'op-v3', now(), 'B000000003', null),
      ('s4', 'e-4', 'amazon', 'op-current', now(), 'B000000004', null)`);
    expect(await outdatedEnrichment({ query }, 10)).toEqual(
      ["op-none", "op-v2", "op-v3"].map((operation, index) => ({
        collectionOperationId: operation,
        channel: "amazon", // Whole Foods reads its Amazon ASIN's enrichment
        listingId: `B00000000${index + 1}`,
        variantId: null,
      })),
    );
  });
});
