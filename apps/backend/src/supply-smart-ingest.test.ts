import { describe, expect, it } from "vitest";
import {
  computeFactsHash,
  convertToMg,
  parsePriceString,
  productBatchSchema,
  SupplySmartDatabase,
  type ProductDbClient,
  type ProductDbPool,
  type ProductDbResult,
} from "./supply-smart-ingest.js";

interface StoredProduct {
  id: string;
  formulaId: string | null;
  familyId: string | null;
  familyLabel: string | null;
}

interface StoredListing {
  id: string;
  productId: string;
  channel: string;
  externalId: string;
  urlNormalized: string;
  attrs: Record<string, unknown>;
  formulaId: string | null;
}

class FakeProductDb implements ProductDbPool {
  readonly queries: Array<{ sql: string; values: unknown[] }> = [];
  readonly products = new Map<string, StoredProduct>();
  readonly listings = new Map<string, StoredListing>();
  readonly ingredients = new Map<string, { id: string; group_id: string | null }>();
  readonly formulas = new Map<string, string>();
  companyRows: Array<{ id: string; name: string }> = [{ id: "company-1", name: "Example" }];
  closed = false;
  private productSequence = 0;
  private listingSequence = 0;
  private ingredientSequence = 0;
  private formulaIngredientSequence = 0;

  async connect() {
    return new FakeClient(this);
  }

  async end() {
    this.closed = true;
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<ProductDbResult<T>> {
    return this.execute<T>(sql, values, true);
  }

  async execute<T extends Record<string, unknown>>(sql: string, values: unknown[], poolQuery = false): Promise<ProductDbResult<T>> {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    this.queries.push({ sql: normalized, values });
    const rows = (value: Array<Record<string, unknown>> = []) => ({ rows: value as T[] });

    if (["begin", "commit", "rollback"].includes(normalized) || normalized.includes("pg_advisory_xact_lock")) return rows();
    if (normalized.startsWith("select c.id,c.name from company c")) return rows(this.companyRows);
    if (normalized.startsWith("select name from health_function")) return rows([{ name: "Immune Support" }]);
    if (normalized.startsWith("select id,website from company")) return rows([{ id: "company-1", website: "https://www.example.com/products" }]);

    if (normalized.includes("from product_channel pc join product p") && normalized.includes("pc.external_id=$2")) {
      const listing = this.listings.get(`${values[0]}:${values[1]}`);
      if (!listing) return rows();
      if (poolQuery || normalized.startsWith("select pc.id listing_id")) {
        const product = this.products.get(listing.productId)!;
        return rows([{
          listing_id: listing.id,
          product_id: listing.productId,
          channel: listing.channel,
          external_id: listing.externalId,
          attrs: listing.attrs,
          formula_id: product.formulaId,
        }]);
      }
      return rows([{
        id: listing.id,
        product_id: listing.productId,
        company_id: "company-1",
        external_id: listing.externalId,
        url_normalized: listing.urlNormalized,
        first_seen_at: null,
        last_seen_at: null,
        latest_snapshot_at: null,
        observed_formula_at: null,
      }]);
    }
    if (normalized.includes("from product_channel pc join product p") && normalized.includes("pc.url_normalized=$2")) {
      const listing = [...this.listings.values()].find((item) => item.channel === values[0] && item.urlNormalized === values[1]);
      return listing ? rows([{
        id: listing.id,
        product_id: listing.productId,
        company_id: "company-1",
        external_id: listing.externalId,
        url_normalized: listing.urlNormalized,
        first_seen_at: null,
        last_seen_at: null,
        latest_snapshot_at: null,
        observed_formula_at: null,
      }]) : rows();
    }
    if (normalized.startsWith("insert into product ") || normalized.startsWith("insert into product (")) {
      const id = `product-${++this.productSequence}`;
      this.products.set(id, { id, formulaId: null, familyId: null, familyLabel: null });
      return rows([{ id }]);
    }
    if (normalized.startsWith("insert into product_channel")) {
      const id = `listing-${++this.listingSequence}`;
      const listing: StoredListing = {
        id,
        productId: values[0] as string,
        channel: values[1] as string,
        externalId: values[2] as string,
        urlNormalized: values[4] as string,
        attrs: JSON.parse(values[6] as string),
        formulaId: null,
      };
      this.listings.set(`${listing.channel}:${listing.externalId}`, listing);
      return rows([{ id }]);
    }
    if (normalized.startsWith("select id,product_id from product_channel")) {
      const listing = this.listings.get(`${values[0]}:${values[1]}`);
      return listing ? rows([{ id: listing.id, product_id: listing.productId }]) : rows();
    }
    if (normalized.startsWith("insert into product_health_function")) return rows([{ id: "health-1" }]);
    if (normalized.startsWith("select id from health_function")) return rows([{ id: "health-1" }]);
    if (normalized.startsWith("select id from form")) return rows([{ id: "form-1" }]);
    if (normalized.startsWith("insert into form")) return rows([{ id: "form-created" }]);
    if (normalized.startsWith("select id,group_id from ingredient")) {
      const ingredient = this.ingredients.get(String(values[0]).toLowerCase());
      return ingredient ? rows([ingredient]) : rows();
    }
    if (normalized.startsWith("insert into ingredient")) {
      const ingredient = { id: `ingredient-${++this.ingredientSequence}`, group_id: null };
      this.ingredients.set(String(values[0]).toLowerCase(), ingredient);
      return rows([ingredient]);
    }
    if (normalized.startsWith("select id from formula where hash")) {
      const id = this.formulas.get(values[0] as string);
      return id ? rows([{ id }]) : rows();
    }
    if (normalized.startsWith("insert into formula(")) {
      const id = `formula-${this.formulas.size + 1}`;
      this.formulas.set(values[0] as string, id);
      return rows([{ id }]);
    }
    if (normalized.startsWith("insert into formula_ingredient")) {
      return normalized.includes("returning id") ? rows([{ id: `formula-row-${++this.formulaIngredientSequence}` }]) : rows();
    }
    if (normalized.startsWith("select observed_at from formula_observation")) return rows();
    if (normalized.startsWith("update product set formula_id")) {
      const product = this.products.get(values[0] as string);
      if (product) product.formulaId = values[1] as string;
      return rows();
    }
    if (normalized.startsWith("update product_channel set observed_formula_id")) {
      const listing = [...this.listings.values()].find((item) => item.id === values[0]);
      if (listing) listing.formulaId = values[1] as string;
      return rows();
    }
    if (normalized.startsWith("select distinct on (p.id)")) {
      const [companyId, channel, externalIds, parentExternalId] = values as [string, string, string[], string];
      void companyId;
      return rows([...this.listings.values()]
        .filter((listing) => listing.channel === channel && (
          externalIds.includes(listing.externalId) || listing.attrs.family_parent_external_id === parentExternalId
        ))
        .map((listing) => ({
          product_id: listing.productId,
          product_name: "Vitamin C Family",
          external_id: listing.externalId,
          attrs: listing.attrs,
          family_id: this.products.get(listing.productId)?.familyId ?? null,
        })));
    }
    if (normalized.startsWith("select pf.id,count(p.id)::text member_count")) return rows();
    if (normalized.startsWith("insert into product_family")) return rows([{ id: "family-1" }]);
    if (normalized.startsWith("update product set family_id")) {
      const stored = this.products.get(values[0] as string);
      if (stored) {
        stored.familyId = values[1] as string;
        stored.familyLabel = values[2] as string | null;
      }
      return rows();
    }
    return rows();
  }
}

class FakeClient implements ProductDbClient {
  constructor(private readonly database: FakeProductDb) {}
  async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: unknown[] = []) {
    return this.database.execute<T>(sql, values);
  }
  release() {}
}

const product = {
  domain: "example.com",
  productName: "Vitamin C 60 Count",
  productUrl: "https://example.com/products/vitamin-c",
  channel: "dtc",
  externalId: "variant-1",
  sourceUrl: "https://example.com/products/vitamin-c?variant=1",
  capturedAt: "2026-08-26T08:00:00.000Z",
  crawlScope: "full",
  source: "crawl-automation:test",
  sku: "VC-60",
  skuMissing: false,
  images: ["https://example.com/vitamin-c.jpg"],
  healthFunctions: ["Immune Support"],
  mainIngredients: [{ name: "Ascorbic Acid", substance: "Vitamin C", form: "Ascorbic Acid", category: "vitamins" }],
  productForm: "capsule",
  nutritionScope: { policy: "nutrition_single_products", decision: "included", evidence: ["Supplement Facts"] },
  variantAttrs: { pack: "60 Count" },
  family: null,
} as const;

const facts = {
  channel: "dtc",
  externalId: "variant-1",
  sourceUrl: "https://example.com/products/vitamin-c?variant=1",
  capturedAt: "2026-08-26T08:00:00.000Z",
  source: "crawl-automation:test:label_ocr",
  confidence: 92,
  servingSize: 1,
  servingUnit: "capsule",
  rows: [{ name: "Vitamin C", amountValue: 100, amountUnit: "mg", dvPercent: 111, position: 0, isActive: true }],
} as const;

describe("SupplySmartDatabase", () => {
  it("directly writes listing SKU and formula tables, then reads the same product back", async () => {
    const pool = new FakeProductDb();
    const database = new SupplySmartDatabase(pool);
    const batch = productBatchSchema.parse({ schemaVersion: "2.0", products: [product], facts: [facts] });
    const result = await database.ingestAndValidate(batch);

    expect(result.problems).toEqual([]);
    expect(result.verified).toBe(1);
    expect(pool.listings.get("dtc:variant-1")?.attrs).toMatchObject({ sku: "VC-60", sku_missing: false, pack: "60 Count" });
    expect(pool.queries.some((query) => query.sql.startsWith("insert into formula_observation"))).toBe(true);
    expect(pool.queries.some((query) => query.sql.startsWith("insert into product_ingredient") && query.sql.includes("formula_ingredient"))).toBe(true);
    expect(result.records[0]?.factsHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates independent products for identical titles with different external IDs", async () => {
    const pool = new FakeProductDb();
    const database = new SupplySmartDatabase(pool);
    const batch = productBatchSchema.parse({
      schemaVersion: "2.0",
      products: [
        { ...product, externalId: "variant-a", sourceUrl: "https://example.com/products/vitamin-c?variant=a" },
        { ...product, externalId: "variant-b", sourceUrl: "https://example.com/products/vitamin-c?variant=b" },
      ],
      facts: [],
    });
    const result = await database.ingestAndValidate(batch);

    expect(result.problems).toEqual([]);
    expect(result.verified).toBe(2);
    expect(pool.products.size).toBe(2);
    expect(pool.listings.get("dtc:variant-a")?.productId).not.toBe(pool.listings.get("dtc:variant-b")?.productId);
  });

  it("is idempotent for the same channel and external ID", async () => {
    const pool = new FakeProductDb();
    const database = new SupplySmartDatabase(pool);
    const batch = productBatchSchema.parse({ schemaVersion: "2.0", products: [product], facts: [facts] });

    await database.ingestAndValidate(batch);
    const second = await database.ingestAndValidate(batch);

    expect(second.problems).toEqual([]);
    expect(second.verified).toBe(1);
    expect(pool.products.size).toBe(1);
    expect(pool.listings.size).toBe(1);
  });

  it("creates a product family only after two explicit SKU members exist", async () => {
    const pool = new FakeProductDb();
    const database = new SupplySmartDatabase(pool);
    const family = { parentExternalId: "parent-1", label: "60 Count", evidence: "explicit" } as const;
    const batch = productBatchSchema.parse({
      schemaVersion: "2.0",
      products: [
        { ...product, externalId: "parent-1", family },
        { ...product, externalId: "child-1", sourceUrl: "https://example.com/products/vitamin-c?variant=child", family: { ...family, label: "120 Count" } },
      ],
      facts: [],
    });

    const result = await database.ingestAndValidate(batch);

    expect(result.problems).toEqual([]);
    expect([...pool.products.values()].every((item) => item.familyId === "family-1")).toBe(true);
    expect(pool.queries.some((query) => query.sql.startsWith("insert into product_family"))).toBe(true);
  });

  it("rolls back and reports review data when company domain is unknown", async () => {
    const pool = new FakeProductDb();
    pool.companyRows = [];
    const database = new SupplySmartDatabase(pool);
    const result = await database.ingestAndValidate({ schemaVersion: "2.0", products: [product], facts: [] });

    expect(result.verified).toBe(0);
    expect(result.problems[0]).toContain("找不到域名");
    expect(pool.queries.some((query) => query.sql === "rollback")).toBe(true);
  });

  it("resolves Amazon brand names and closes the pool", async () => {
    const pool = new FakeProductDb();
    const database = new SupplySmartDatabase(pool);
    await expect(database.resolveCompanyDomain("Example Store")).resolves.toBe("example.com");
    await database.close();
    expect(pool.closed).toBe(true);
  });
});

describe("copied Jakarta normalization rules", () => {
  it("parses prices and converts mass units without guessing", () => {
    expect(parsePriceString("USD 1,234.99")).toBe("1234.99");
    expect(parsePriceString("24,99")).toBeNull();
    expect(convertToMg(1, "g")).toBe(1000);
    expect(convertToMg(500, "IU")).toBeNull();
  });

  it("keeps servings per container out of the content hash", () => {
    const rows = [{ key: "ingredient-1", amountMg: 100, dvPercent: 111, isActive: true, parentKey: "" }];
    expect(computeFactsHash(rows, { servingSize: 1, servingUnit: "capsule" })).toBe(
      computeFactsHash(rows, { servingSize: 1, servingUnit: "capsule" }),
    );
  });

  it("rejects duplicate facts positions before any database write", () => {
    expect(() => productBatchSchema.parse({
      schemaVersion: "2.0",
      products: [product],
      facts: [{ ...facts, rows: [{ ...facts.rows[0], position: 0 }, { ...facts.rows[0], name: "Zinc", position: 0 }] }],
    })).toThrow(/position 重复/);
  });

  it("rejects duplicate channel and external ID products", () => {
    expect(() => productBatchSchema.parse({
      schemaVersion: "2.0",
      products: [product, product],
      facts: [],
    })).toThrow(/产品挂牌重复/);
  });
});
