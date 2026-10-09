import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { Queryable } from "@crawl-automation/platform";
import { expect, it } from "vitest";
import { PostgresDeliveryReader } from "./postgres-delivery-reader.js";
import { deliveryRequest } from "./product.fixture.js";

const connectionString = process.env["CRAWL_TEST_DATABASE_URL"];

it.skipIf(!connectionString)(
  "selects only the latest exact-source SKU state, not old successes or another site's same ID",
  async () => {
    const client = new Client({ connectionString });
    await client.connect();
    const schema = `product_delivery_${randomUUID().replaceAll("-", "")}`;
    const source = randomUUID();
    const other = randomUUID();
    const runId = randomUUID();
    const batch = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path=${schema}`);
      await client.query(`
      CREATE TABLE brand_source(id uuid, channel text);
      CREATE TABLE dtc_source_settings(source_id uuid, settings jsonb);
      CREATE TABLE review_record(record jsonb);
      CREATE TABLE product_enrichment_attempt(subject jsonb);
      CREATE TABLE product_enrichment_subject(collection_operation_id text,channel text,listing_id text,variant_id text);
      CREATE TABLE queue_item(item_id text, batch_id uuid, source_id uuid, listing_id text,
        variant_id text, state text, run_id uuid, channel text, created_at timestamptz);
      CREATE TABLE queue_attempt(run_id uuid, settled_at timestamptz, outcome text);
      CREATE TABLE brand_scan(source_id uuid, scan_id uuid, state text, started_at timestamptz,
        requested_at timestamptz, result jsonb, channel text);
      CREATE TABLE collected_product(operation_id text, record jsonb, collected_at timestamptz);`);
      await client.query("INSERT INTO brand_source VALUES ($1,'dtc'),($2,'dtc')", [source, other]);
      await client.query("INSERT INTO queue_attempt VALUES ($1,now(),'completed')", [runId]);
      await client.query(
        `INSERT INTO queue_item VALUES
      ('old',$1,$2,'same',NULL,'completed',$3,'dtc',now()-interval '1 day'),
      ('new',$1,$2,'same',NULL,'review',$3,'dtc',now()),
      ('foreign',$1,$4,'same',NULL,'completed',$3,'dtc',now()),
      ('active',$1,$2,'active',NULL,'running',$3,'dtc',now()),
      ('complete',$1,$2,'complete',NULL,'completed',$3,'dtc',now())`,
        [batch, source, runId, other],
      );
      const query: Queryable["query"] = async (sql, values) =>
        (await client.query(sql, [...(values ?? [])])).rows;
      const reader = new PostgresDeliveryReader({
        database: { query },
        objects: { read: async () => null },
      });
      const result = await reader.read(
        { ...deliveryRequest, sourceIds: [source] },
        new AbortController().signal,
      );
      expect(result.review).toBe(1);
      expect(result.pending).toBe(1);
      expect(result.products).toMatchObject([
        { queueId: "complete", externalId: "complete", sourceId: source },
      ]);
      expect(result.products).toHaveLength(1);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);
