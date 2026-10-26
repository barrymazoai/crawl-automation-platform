import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import { refreshedHealthFunctions } from "./product-sync-health-functions.js";

// Runs against CRAWL_TEST_DATABASE_URL; all DDL/data live in a rolled-back private schema.
const connectionString = process.env["CRAWL_TEST_DATABASE_URL"];
const migration = new URL("../../../../database/v3/061_product_sync.sql", import.meta.url);
let client: Client;
const query: Queryable["query"] = async (sql, values) =>
  (await client.query(sql, [...(values ?? [])])).rows;
const product = (index: number) => `00000000-0000-4000-8000-00000000000${index}`;

describe.skipIf(!connectionString)("products refreshed with the current enrichment", () => {
  beforeEach(async () => {
    client = new Client({ connectionString });
    await client.connect();
    await client.query("BEGIN");
    const schema = `refreshed_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path = ${schema}`);
    await client.query(
      (await readFile(migration, "utf8"))
        .replace(/^(BEGIN|COMMIT);$/gm, "")
        .replace(/^SET LOCAL search_path = public;$/m, ""),
    );
    await client.query(`
      CREATE TABLE product_enrichment(enrichment_id text PRIMARY KEY, protocol text, record jsonb);
      CREATE TABLE product_enrichment_subject(subject_id text, enrichment_id text, channel text,
        collection_operation_id text, registered_at timestamptz, listing_id text, variant_id text)`);
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  it("lists products all of whose listings were sent after a /4 enrichment, with current and earlier names", async () => {
    await client.query(
      `
      INSERT INTO product_sync (channel, listing_id, status, payload_hash, ingest_run_id, supply_smart_product_id,
                                material_at, updated_at)
      SELECT ch, id, st, repeat('a', 64), 'run', pid::uuid, now(), now()
        FROM (VALUES ('amazon', 'B1', 'verified', $1), ('wholefoods', 'B1', 'verified', $1),
                     ('amazon', 'B2', 'verified', $2), ('amazon', 'B3', 'verified', $3),
                     ('amazon', 'B4', 'verified', $4), ('amazon', 'B5', 'sent', $5)) AS v(ch, id, st, pid)`,
      [product(1), product(2), product(3), product(4), product(5)],
    );
    const candidate = (printed: string[], inferred: string[] = []) =>
      JSON.stringify({
        candidate: { healthFunctions: printed, inferredHealthFunctions: inferred },
      });
    await client.query(
      `
      INSERT INTO product_enrichment VALUES
        ('e1-old', 'product-enrichment/3', $1), ('e1-new', 'product-enrichment/4', $2),
        ('e2-new', 'product-enrichment/4', $3), ('e3-old', 'product-enrichment/3', $4),
        ('e4-new', 'product-enrichment/4', $5), ('e5-new', 'product-enrichment/4', $3)`,
      [
        candidate(["supports healthy joints", "Joint Health"]),
        candidate(["Joint Health"], ["Bone Health"]),
        candidate(["X"]),
        candidate(["old"]),
        candidate([], ["Calm Support"]),
      ],
    );
    await client.query(`
      INSERT INTO product_enrichment_subject VALUES
        ('s1a', 'e1-old', 'amazon', 'op1', now() - interval '2 days', 'B1', null),
        ('s1b', 'e1-new', 'amazon', 'op1', now() - interval '1 hour', 'B1', null),
        -- enriched again after the send: not resent yet
        ('s2', 'e2-new', 'amazon', 'op2', now() + interval '1 hour', 'B2', null),
        ('s3', 'e3-old', 'amazon', 'op3', now() - interval '1 hour', 'B3', null),
        ('s4', 'e4-new', 'amazon', 'op4', now() - interval '1 hour', 'B4', null),
        -- outcome unknown: not verified
        ('s5', 'e5-new', 'amazon', 'op5', now() - interval '1 hour', 'B5', null)`);
    expect(await refreshedHealthFunctions({ query }, { limit: 10 })).toEqual([
      {
        supplySmartProductId: product(1),
        current: ["Joint Health"],
        previous: ["Joint Health", "supports healthy joints"],
      },
      { supplySmartProductId: product(4), current: ["Calm Support"], previous: [] },
    ]);
    expect(await refreshedHealthFunctions({ query }, { after: product(1), limit: 10 })).toEqual([
      { supplySmartProductId: product(4), current: ["Calm Support"], previous: [] },
    ]);
  });
});
