import { describe, expect, it } from "vitest";
import { buildObservationPayload, ProductObservationClient } from "./product-observation-client.js";
import { productBatchSchema } from "./supply-smart-ingest.js";

const product = {
  domain: "optimumnutrition.com",
  productName: "Gold Standard 100% Whey — Vanilla Cream, 4 lb, Powder",
  titleRaw: "Optimum Nutrition Gold Standard Whey Protein Powder Vanilla Cream 4 lb",
  productUrl: "https://www.gnc.com/whey-protein/379969.html",
  channel: "gnc",
  externalId: "379969",
  sourceUrl: "https://www.gnc.com/whey-protein/379969.html",
  capturedAt: "2026-08-28T01:23:45.000Z",
  crawlScope: "full",
  source: "crawl-automation:run-1",
  sku: "379969",
  skuMissing: false,
  price: "74.99",
  currency: "USD",
  images: ["https://www.gnc.com/front.jpg"],
  healthFunctions: ["Muscle Recovery"],
  mainIngredients: ["Whey Protein Isolate"],
  productForm: "powder",
  nutritionScope: { policy: "nutrition_single_products", decision: "included", evidence: ["Supplement Facts"] },
  gtin: "048107252779",
  baseName: "Gold Standard 100% Whey",
  variant: { flavor: "Vanilla Cream", size: "4 lb", form: "powder" },
  variantConfidence: 96,
  variantSource: "channel_attrs",
  attrsRaw: { flavor: "Vanilla Cream", size: "4 lb", upc: "048107252779" },
  variantAttrs: { flavor: "Vanilla Cream", size: "4 lb", category: "Whey Protein" },
  family: null,
} as const;

const facts = {
  channel: "gnc",
  externalId: "379969",
  sourceUrl: "https://www.gnc.com/379969_lbl.pdf",
  sourceImageUrl: "https://www.gnc.com/379969_lbl.pdf",
  capturedAt: product.capturedAt,
  source: "crawl-automation:run-1:label_ocr",
  confidence: 95,
  servingSize: 1,
  servingUnit: "scoop",
  servingsPerContainer: 64,
  netContent: "4 lb",
  rows: [{ name: "Protein", amountValue: 24, amountUnit: "g", position: 0, isActive: true }],
} as const;

function batch() {
  return productBatchSchema.parse({ schemaVersion: "2.0", products: [product], facts: [facts] });
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify({ json: value }), { status, headers: { "content-type": "application/json" } });
}

function ingestOutput(identityState = "resolved") {
  return {
    runId: "run-1",
    crawlRunId: "crawl-1",
    counts: { received: 1, ok: 1, failed: 0, created: 1, matched: 0, needsReview: identityState === "resolved" ? 0 : 1 },
    results: [{
      clientRef: "gnc:379969",
      status: "ok",
      productId: "product-1",
      listingId: "listing-1",
      matchedBy: "created",
      identity: { state: identityState, variantKey: identityState === "resolved" ? "flavor=vanilla_cream" : null },
      facts: { factsHash: "facts-hash" },
      error: null,
    }],
  };
}

function verifyOutput(problems: string[]) {
  return {
    runId: "run-1",
    found: true,
    verified: 1,
    expected: 1,
    items: [{ clientRef: "gnc:379969", problems: [], mismatches: [] }],
    problems,
    readbackHash: problems.length ? "pre-hash" : "post-hash",
  };
}

describe("observation payload conversion", () => {
  it("maps identity, SKU evidence, category, image roles, and Facts without leaking illegal variant keys", () => {
    const prepared = buildObservationPayload(batch(), {
      runId: "run-1",
      sourceUrl: product.sourceUrl,
    });

    expect(prepared.run).toMatchObject({ channel: "gnc", scope: "partial", companyDomain: "optimumnutrition.com" });
    expect(prepared.items[0]).toMatchObject({
      clientRef: "gnc:379969",
      gtin: "048107252779",
      baseName: "Gold Standard 100% Whey",
      variant: { flavor: "Vanilla Cream", size: "4 lb", form: "powder" },
      attrsRaw: { sku: "379969", skuMissing: false, upc: "048107252779" },
      extras: { category: "Whey Protein" },
      facts: { sourceImageRef: "image-002", netContent: "4 lb" },
    });
    expect(prepared.items[0]?.images).toEqual([
      { clientRef: "image-001", url: "https://www.gnc.com/front.jpg", role: "gallery" },
      { clientRef: "image-002", url: "https://www.gnc.com/379969_lbl.pdf", role: "facts" },
    ]);
    expect(prepared.items[0]?.variant).not.toHaveProperty("upc");
    expect(prepared.items[0]?.variant).not.toHaveProperty("category");
  });

  it("keeps a complete DTC catalog full and scopes it by siteKey", () => {
    const dtc = {
      ...product,
      domain: "motherspromise.com",
      channel: "dtc",
      externalId: "motherspromise.com:shopify_variant:1",
      sourceUrl: "https://www.motherspromise.com/products/test?variant=1",
      productUrl: "https://www.motherspromise.com/products/test",
    };
    const prepared = buildObservationPayload({ schemaVersion: "2.0", products: [dtc], facts: [] }, {
      runId: "run-dtc",
      sourceUrl: "https://www.motherspromise.com/collections/all",
    });
    expect(prepared.run).toMatchObject({ channel: "dtc", scope: "full", siteKey: "motherspromise.com" });
  });

  it("keeps an exhausted Amazon Brand Store run full and scopes it by company", () => {
    const source = batch();
    const prepared = buildObservationPayload({
      ...source,
      facts: [],
      products: [{
        ...source.products[0]!,
        channel: "amazon",
        externalId: "B000000001",
        productUrl: "https://www.amazon.com/dp/B000000001",
        sourceUrl: "https://www.amazon.com/dp/B000000001",
        crawlScope: "full",
      }],
    }, { runId: "amazon-store-run", sourceUrl: "https://www.amazon.com/stores/Example/page/00000000-0000-0000-0000-000000000000" });
    expect(prepared.run).toMatchObject({ channel: "amazon", scope: "full", companyDomain: "optimumnutrition.com" });
    expect(prepared.run.siteKey).toBeUndefined();
  });
});

describe("ProductObservationClient", () => {
  it("uses the oRPC envelope and gates completion between pre/post verification", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const responses = [
      json(ingestOutput()),
      json(verifyOutput(["run_not_completed"])),
      json({ runId: "run-1", found: true, replayed: false, scope: "partial", status: "completed", deactivated: 0, deactivatedListingIds: [], problems: [] }),
      json(verifyOutput([])),
    ];
    const client = new ProductObservationClient({
      baseUrl: "https://product.example.com/",
      retries: 0,
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return responses.shift()!;
      },
    });

    const result = await client.ingestAndValidate(batch(), { runId: "run-1", sourceUrl: product.sourceUrl });
    expect(result.problems).toEqual([]);
    expect(result.verified).toBe(1);
    expect(result.readbackHash).not.toBe("pre-hash");
    expect(calls.map((call) => call.url.split("/").at(-1))).toEqual([
      "ingestObservationBatch", "verifyObservationBatch", "completeCrawlRun", "verifyObservationBatch",
    ]);
    expect(calls[0]?.body).toMatchObject({ json: { run: { runId: "run-1" }, items: [{ clientRef: "gnc:379969" }] } });
  });

  it("does not complete a run when Jakarta reports unresolved identity", async () => {
    const names: string[] = [];
    const client = new ProductObservationClient({
      baseUrl: "https://product.example.com",
      retries: 0,
      fetch: async (url) => {
        const name = String(url).split("/").at(-1)!;
        names.push(name);
        return name === "ingestObservationBatch"
          ? json(ingestOutput("variant_unresolved"))
          : json(verifyOutput(["run_not_completed"]));
      },
    });
    const result = await client.ingestAndValidate(batch(), { runId: "run-1", sourceUrl: product.sourceUrl });
    expect(result.problems).toContain("gnc:379969: identity_variant_unresolved");
    expect(names).toEqual(["ingestObservationBatch", "verifyObservationBatch"]);
  });

  it("accepts an older Facts observation when a later item in the same batch maps to the same product", async () => {
    const secondProduct = {
      ...product,
      externalId: "379970",
      sourceUrl: "https://www.gnc.com/whey-protein/379970.html",
      productUrl: "https://www.gnc.com/whey-protein/379970.html",
      capturedAt: "2026-08-28T01:24:45.000Z",
    };
    const secondFacts = { ...facts, externalId: "379970", capturedAt: secondProduct.capturedAt };
    const source = productBatchSchema.parse({ schemaVersion: "2.0", products: [product, secondProduct], facts: [facts, secondFacts] });
    const ingest = {
      runId: "run-1",
      crawlRunId: "crawl-1",
      counts: { received: 2, ok: 2, failed: 0, created: 1, matched: 1, needsReview: 0 },
      results: [
        { ...ingestOutput().results[0], clientRef: "gnc:379969", productId: "same-product", facts: { factsHash: "older-hash" } },
        { ...ingestOutput().results[0], clientRef: "gnc:379970", productId: "same-product", listingId: "listing-2", facts: { factsHash: "latest-hash" } },
      ],
    };
    const verify = {
      runId: "run-1",
      found: true,
      verified: 1,
      expected: 2,
      items: [
        { clientRef: "gnc:379969", problems: ["facts_not_latest"], mismatches: [] },
        { clientRef: "gnc:379970", problems: [], mismatches: [] },
      ],
      problems: ["run_not_completed"],
      readbackHash: "same-product-hash",
    };
    const calls: Array<{ body: any }> = [];
    const responses = [
      json(ingest),
      json(verify),
      json({ runId: "run-1", found: true, replayed: false, scope: "partial", status: "completed", deactivated: 0, deactivatedListingIds: [], problems: [] }),
      json({ ...verify, problems: [] }),
    ];
    const client = new ProductObservationClient({
      baseUrl: "https://product.example.com",
      retries: 0,
      fetch: async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return responses.shift()!;
      },
    });

    const result = await client.ingestAndValidate(source, { runId: "run-1", sourceUrl: product.sourceUrl });
    expect(result.problems).toEqual([]);
    expect(result.verified).toBe(2);
    const expectations = calls[1]?.body.json.expect;
    expect(expectations[0]).not.toHaveProperty("factsHash");
    expect(expectations[1]).toHaveProperty("factsHash", "latest-hash");
  });
});
