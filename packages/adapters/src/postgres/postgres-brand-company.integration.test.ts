import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrandCompanyMatch, BrandCompanyChannel } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { PostgresBrandCompany } from "./postgres-brand-company.js";

// Main session runs this against CRAWL_TEST_DATABASE_URL; all DDL/data live in a rolled-back private schema.
const connectionString = process.env["CRAWL_TEST_DATABASE_URL"];
const migration = new URL(
  "../../../../database/v3/060_supply_smart_brand_company.sql",
  import.meta.url,
);
const channels: BrandCompanyChannel[] = ["amazon", "gnc", "swanson", "wholefoods", "costco"];
const checkedAt = "2026-10-12T10:00:00.000Z";
let client: Client;
let repository: PostgresBrandCompany;

describe.skipIf(!connectionString)("marketplace brand company repository and migration 060", () => {
  beforeEach(async () => {
    client = new Client({ connectionString });
    await client.connect();
    const schema = `brand_company_${randomUUID().replaceAll("-", "")}`;
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path = ${schema}`);
    await client.query(`
      CREATE TABLE brand(id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE brand_source(id uuid PRIMARY KEY, brand_id uuid, channel text, url text, enabled boolean);
      CREATE TABLE queue_item(item_id text PRIMARY KEY, channel text, listing_id text, variant_id text,
        source_id uuid, state text, created_at timestamptz);`);
    const ddl = (await readFile(migration, "utf8"))
      .replace(/^(BEGIN|COMMIT);$/gm, "")
      .replace(/^SET LOCAL search_path = public;$/m, "");
    await client.query(ddl);
    const query: Queryable["query"] = async (sql, values) =>
      (await client.query(sql, [...(values ?? [])])).rows;
    repository = new PostgresBrandCompany({ query });
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  it("upserts one row per brand, replaces old identity/candidates, and lists by status", async () => {
    const { brandId } = await seedBrand();
    const candidates = [randomUUID(), randomUUID()];
    await repository.upsert(savedMatch(brandId, { status: "ambiguous", candidates }));
    expect((await repository.list({ status: "ambiguous", limit: 10 }))[0]?.match).toEqual(
      savedMatch(brandId, { status: "ambiguous", candidates }),
    );
    const matched = savedMatch(brandId, {
      status: "matched",
      companyId: randomUUID(),
      domain: "example.com",
      matchedBy: "name",
    });
    await repository.upsert(matched);
    expect((await repository.list({ status: "matched", limit: 10 }))[0]?.match).toEqual(matched);
    expect(await repository.list({ status: "ambiguous", limit: 10 })).toEqual([]);
    await repository.upsert(savedMatch(brandId, { matchedBy: "no_website" }));
    expect((await repository.list({ status: "unmatched", limit: 10 }))[0]?.match).toEqual(
      savedMatch(brandId, { matchedBy: "no_website" }),
    );
    expect((await client.query("SELECT * FROM supply_smart_brand_company")).rows).toHaveLength(1);
  });

  it("counts latest completed listing variants for all five channels, including disabled sources", async () => {
    const { brandId, sourceId } = await seedBrand();
    await seedItem({ sourceId, listingId: "product", variantId: null });
    await seedItem({ sourceId, listingId: "product", variantId: "large" });
    for (const channel of channels.slice(1)) {
      const channelSource = await seedSource({ brandId, channel });
      await seedItem({ sourceId: channelSource, channel, listingId: "product" });
    }
    const result = await repository.list({ limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      brandId,
      match: null,
      dtcDomain: null,
      productCounts: { amazon: 3, gnc: 1, swanson: 1, wholefoods: 1, costco: 1 },
    });
  });

  it.each(["queued", "running", "review", "failed", "cancelled"])(
    "newer %s hides an older completed item",
    async (state) => {
      const { sourceId, listingId } = await seedBrand();
      await seedItem({ sourceId, listingId, state, createdAt: "2026-10-12T11:00:00Z" });
      expect(await repository.list({ limit: 10 })).toEqual([]);
    },
  );

  it("deduplicates across brand sources after choosing the latest item, with a stable item-ID tie break", async () => {
    const first = await seedBrand();
    const second = await seedBrand({ withItem: false });
    await seedItem({
      sourceId: second.sourceId,
      listingId: first.listingId,
      itemId: "z-latest",
      createdAt: "2026-10-13T00:00:00Z",
    });
    await seedItem({
      sourceId: first.sourceId,
      listingId: first.listingId,
      itemId: "a-older",
      createdAt: "2026-10-13T00:00:00Z",
    });
    const rows = await repository.list({ limit: 10 });
    expect(rows.map((row) => row.brandId)).toEqual([second.brandId]);
    expect(rows[0]?.productCounts.amazon).toBe(1);
  });

  it("does not revive older branded completion when the latest item has no brand source", async () => {
    const { listingId } = await seedBrand();
    await seedItem({ sourceId: null, listingId, createdAt: "2026-10-13T00:00:00Z" });
    expect(await repository.list({ limit: 10 })).toEqual([]);
  });

  it("excludes DTC-only, incomplete, missing-source, and channel-mismatched brands", async () => {
    const dtc = await seedBrand({ channel: "dtc" });
    const empty = await seedBrand({ withItem: false });
    await seedItem({ sourceId: empty.sourceId, state: "running" });
    await seedItem({ sourceId: dtc.sourceId, channel: "amazon" });
    await seedItem({ sourceId: randomUUID() });
    expect(await repository.list({ limit: 10 })).toEqual([]);
  });

  it("normalizes DTC catalog URLs without multiplying counts; conflicting hosts supply no hint", async () => {
    const { brandId } = await seedBrand();
    await seedSource({ brandId, channel: "dtc", url: "https://WWW.Example.co.uk:443/catalog" });
    await seedSource({ brandId, channel: "dtc", url: "https://example.co.uk/shop" });
    let rows = await repository.list({ limit: 10 });
    expect(rows[0]?.dtcDomain).toBe("example.co.uk");
    expect(rows[0]?.productCounts.amazon).toBe(1);
    await seedSource({ brandId, channel: "dtc", url: "https://different.example/catalog" });
    rows = await repository.list({ limit: 10 });
    expect(rows[0]?.dtcDomain).toBeNull();
  });

  it("filters recently checked and matched rows before LIMIT, preferring unchecked then oldest waiting", async () => {
    const matched = await seedBrand();
    const recent = await seedBrand();
    const stale = await seedBrand();
    const unchecked = await seedBrand();
    await repository.upsert(
      savedMatch(matched.brandId, {
        status: "matched",
        companyId: randomUUID(),
        domain: "example.com",
        checkedAt: "2026-01-01T00:00:00Z",
      }),
    );
    await repository.upsert(savedMatch(recent.brandId, { status: "ambiguous" }));
    await repository.upsert(savedMatch(stale.brandId, { checkedAt: "2026-10-11T10:00:00.000Z" }));
    const filter = { limit: 1, checkedBefore: "2026-10-11T10:00:00.000Z", recheckUnmatched: false };
    expect((await repository.candidates(filter)).map((row) => row.brandId)).toEqual([
      unchecked.brandId,
    ]);
    await repository.upsert(savedMatch(unchecked.brandId));
    expect((await repository.candidates(filter)).map((row) => row.brandId)).toEqual([
      stale.brandId,
    ]);
    expect(
      (await repository.candidates({ ...filter, limit: 10, recheckUnmatched: true }))
        .map((row) => row.brandId)
        .sort(),
    ).toEqual([recent.brandId, stale.brandId, unchecked.brandId].sort());
  });

  it("orders and limits the status query deterministically", async () => {
    const first = await seedBrand({ name: "AAA" });
    const second = await seedBrand({ name: "BBB" });
    await repository.upsert(savedMatch(first.brandId));
    await repository.upsert(savedMatch(second.brandId));
    expect(
      (await repository.list({ status: "unmatched", limit: 1 })).map((row) => row.brandId),
    ).toEqual([first.brandId]);
  });

  it("enforces brand existence and prevents deleting a brand with a company record", async () => {
    await constraintFailure(() => repository.upsert(savedMatch(randomUUID())), "23503");
    const { brandId } = await seedBrand({ withItem: false });
    await repository.upsert(savedMatch(brandId));
    await constraintFailure(
      () => client.query("DELETE FROM brand WHERE id = $1", [brandId]),
      "23503",
    );
  });

  it("requires both company ID and nonempty domain exactly for matched results", async () => {
    const { brandId } = await seedBrand();
    const invalid: Partial<BrandCompanyMatch>[] = [
      { status: "matched" },
      { status: "matched", companyId: randomUUID() },
      { status: "matched", domain: "example.com" },
      { status: "matched", companyId: randomUUID(), domain: "  " },
      { status: "unmatched", companyId: randomUUID() },
      { status: "ambiguous", domain: "example.com" },
    ];
    for (const overrides of invalid) {
      await constraintFailure(() => repository.upsert(savedMatch(brandId, overrides)), "23514");
    }
  });

  it("bounds candidates to 20 UUID strings, only for ambiguous results", async () => {
    const { brandId } = await seedBrand();
    const candidates = Array.from({ length: 20 }, () => randomUUID());
    await repository.upsert(savedMatch(brandId, { status: "ambiguous", candidates }));
    expect((await repository.list({ limit: 1 }))[0]?.match?.candidates).toEqual(candidates);
    for (const invalid of [[...candidates, randomUUID()], ["bad-id"], [123], {}, null]) {
      await constraintFailure(
        () =>
          client.query(
            "UPDATE supply_smart_brand_company SET candidates = $1::jsonb WHERE brand_id = $2",
            [JSON.stringify(invalid), brandId],
          ),
        "23514",
      );
    }
    await constraintFailure(
      () => repository.upsert(savedMatch(brandId, { candidates: [randomUUID()] })),
      "23514",
    );
  });

  it("sets checked_at and empty candidates by default and rejects unsupported status", async () => {
    const { brandId } = await seedBrand();
    await client.query(
      "INSERT INTO supply_smart_brand_company (brand_id, status) VALUES ($1, 'unmatched')",
      [brandId],
    );
    const row = (await repository.list({ limit: 1 }))[0]?.match;
    expect(row?.candidates).toEqual([]);
    expect(Number.isFinite(Date.parse(row?.checkedAt ?? ""))).toBe(true);
    await constraintFailure(
      () =>
        client.query("UPDATE supply_smart_brand_company SET status = 'error' WHERE brand_id = $1", [
          brandId,
        ]),
      "23514",
    );
  });
});

function savedMatch(
  brandId: string,
  overrides: Partial<BrandCompanyMatch> = {},
): BrandCompanyMatch {
  return {
    brandId,
    status: "unmatched",
    companyId: null,
    domain: null,
    matchedBy: null,
    candidates: [],
    checkedAt,
    ...overrides,
  };
}
async function seedBrand(options: { name?: string; channel?: string; withItem?: boolean } = {}) {
  const brandId = randomUUID();
  await client.query("INSERT INTO brand VALUES ($1, $2)", [
    brandId,
    options.name ?? `Brand ${brandId}`,
  ]);
  const channel = options.channel ?? "amazon";
  const sourceId = await seedSource({ brandId, channel });
  const listingId = randomUUID();
  if (options.withItem !== false) {
    await seedItem({ sourceId, listingId, channel });
  }
  return { brandId, sourceId, listingId };
}
async function seedSource(options: { brandId: string; channel: string; url?: string }) {
  const sourceId = randomUUID();
  await client.query("INSERT INTO brand_source VALUES ($1, $2, $3, $4, false)", [
    sourceId,
    options.brandId,
    options.channel,
    options.url ?? "https://shop.example/catalog",
  ]);
  return sourceId;
}
async function seedItem(options: {
  sourceId: string | null;
  channel?: string;
  listingId?: string;
  variantId?: string | null;
  state?: string;
  createdAt?: string;
  itemId?: string;
}) {
  await client.query("INSERT INTO queue_item VALUES ($1, $2, $3, $4, $5, $6, $7)", [
    options.itemId ?? randomUUID(),
    options.channel ?? "amazon",
    options.listingId ?? randomUUID(),
    options.variantId ?? null,
    options.sourceId,
    options.state ?? "completed",
    options.createdAt ?? "2026-10-12T10:00:00Z",
  ]);
}
async function constraintFailure(work: () => Promise<unknown>, code: string) {
  await client.query("SAVEPOINT invalid_row");
  await expect(work()).rejects.toMatchObject({ code });
  await client.query("ROLLBACK TO SAVEPOINT invalid_row");
}
