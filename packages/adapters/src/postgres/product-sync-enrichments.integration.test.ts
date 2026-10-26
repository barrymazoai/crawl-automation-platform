import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import { refreshedEnrichments } from "./product-sync-enrichments.js";

// Runs against CRAWL_TEST_DATABASE_URL; all DDL/data live in a rolled-back private schema.
const connectionString = process.env["CRAWL_TEST_DATABASE_URL"];
const migration = new URL("../../../../database/v3/061_product_sync.sql", import.meta.url);
let client: Client;
const query: Queryable["query"] = async (sql, values) =>
  (await client.query(sql, [...(values ?? [])])).rows;
const product = (index: number) => `00000000-0000-4000-8000-00000000000${index}`;
const candidate = (
  form: string,
  printed: string[],
  extra: { inferred?: string[]; main?: string[] } = {},
) =>
  JSON.stringify({
    candidate: {
      form,
      healthFunctions: printed,
      inferredHealthFunctions: extra.inferred ?? [],
      functionalIngredients: extra.main ?? [],
    },
  });
const none = { forms: [], healthFunctions: [], mainIngredients: [] };

describe.skipIf(!connectionString)("products whose enrichment is current", () => {
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

  it("lists products all of whose listings have a /4 enrichment, with current and earlier names", async () => {
    await client.query(
      `
      INSERT INTO product_sync (channel, listing_id, status, payload_hash, ingest_run_id, supply_smart_product_id,
                                collected_operation_id, material_at, updated_at)
      SELECT ch, id, st, repeat('a', 64), 'run', pid::uuid, op, now(), now()
        FROM (VALUES ('amazon', 'B1', 'verified', $1, 'op1'), ('wholefoods', 'B1', 'verified', $1, 'op1'),
                     ('amazon', 'B2', 'verified', $2, 'op2'), ('amazon', 'B3', 'verified', $3, 'op3'),
                     -- a resend refused as an idempotency conflict: the product is in Supply Smart
                     ('amazon', 'B4', 'failed', $4, 'op4'),
                     -- the ledger has the page slug, the subject the store's numeric ID
                     ('swanson', 'milk-thistle-16-oz', 'verified', $5, 'op5'))
             AS v(ch, id, st, pid, op)`,
      [product(1), product(2), product(3), product(4), product(5)],
    );
    await client.query(
      `
      INSERT INTO product_enrichment VALUES
        ('e1-old', 'product-enrichment/3', $1), ('e1-new', 'product-enrichment/4', $2),
        ('e2-new', 'product-enrichment/4', $3), ('e3-old', 'product-enrichment/3', $4),
        ('e4-new', 'product-enrichment/4', $5)`,
      [
        candidate("chewable", ["supports healthy joints", "Joint Health"], {
          main: ["Glucosamine", "Chondroitin"],
        }),
        candidate("tablet", ["Joint Health"], { inferred: ["Bone Health"], main: ["Glucosamine"] }),
        candidate("unknown", ["X"]),
        candidate("other", ["old"]),
        candidate("capsule", [], { inferred: ["Calm Support"] }),
      ],
    );
    await client.query(`
      INSERT INTO product_enrichment_subject VALUES
        -- an earlier collection of the same listing
        ('s1a', 'e1-old', 'amazon', 'op1-old', now() - interval '2 days', 'B1', null),
        ('s1b', 'e1-new', 'amazon', 'op1', now() - interval '1 hour', 'B1', null),
        -- enriched again after the send: Supply Smart lacks its names
        ('s2', 'e2-new', 'amazon', 'op2', now() + interval '1 hour', 'B2', null),
        ('s3', 'e3-old', 'amazon', 'op3', now() - interval '1 hour', 'B3', null),
        ('s4', 'e4-new', 'amazon', 'op4', now() - interval '1 hour', 'B4', null),
        ('s5a', 'e1-old', 'swanson', 'op5', now() - interval '2 hours', '8572', '4631'),
        ('s5b', 'e4-new', 'swanson', 'op5', now() - interval '1 hour', '8572', '4631')`);
    const calm = { forms: ["capsule"], healthFunctions: ["Calm Support"], mainIngredients: [] };
    expect(await refreshedEnrichments({ query }, { limit: 10 })).toEqual([
      {
        supplySmartProductId: product(1),
        current: {
          forms: ["tablet"],
          healthFunctions: ["Joint Health"],
          mainIngredients: ["Glucosamine"],
        },
        previous: {
          forms: ["chewable"],
          healthFunctions: ["Joint Health", "supports healthy joints"],
          mainIngredients: ["Chondroitin", "Glucosamine"],
        },
        sentBeforeCurrent: false,
      },
      {
        supplySmartProductId: product(2),
        current: { forms: [], healthFunctions: ["X"], mainIngredients: [] },
        previous: none,
        sentBeforeCurrent: true,
      },
      { supplySmartProductId: product(4), current: calm, previous: none, sentBeforeCurrent: true },
      {
        supplySmartProductId: product(5),
        current: calm,
        previous: {
          forms: ["chewable"],
          healthFunctions: ["Joint Health", "supports healthy joints"],
          mainIngredients: ["Chondroitin", "Glucosamine"],
        },
        sentBeforeCurrent: false,
      },
    ]);
    expect(
      (await refreshedEnrichments({ query }, { after: product(2), limit: 1 })).map(
        (row) => row.supplySmartProductId,
      ),
    ).toEqual([product(4)]);
  });
});
