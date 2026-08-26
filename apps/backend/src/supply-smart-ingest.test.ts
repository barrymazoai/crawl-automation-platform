import { describe, expect, it } from "vitest";
import { productBatchSchema, SupplySmartApi } from "./supply-smart-ingest.js";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify({ json: value }), { status, headers: { "content-type": "application/json" } });
}

const batch = productBatchSchema.parse({
  schemaVersion: "2.0",
  products: [{
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
  }],
  facts: [{
    channel: "dtc",
    externalId: "variant-1",
    sourceUrl: "https://example.com/products/vitamin-c?variant=1",
    capturedAt: "2026-08-26T08:00:00.000Z",
    source: "crawl-automation:test:label_ocr",
    confidence: 92,
    servingSize: 1,
    servingUnit: "capsule",
    rows: [{ name: "Vitamin C", amountValue: 100, amountUnit: "mg", dvPercent: 111, position: 0, isActive: true }],
  }],
});

describe("SupplySmartApi", () => {
  it("uses enrich, submitFacts, and getById and carries SKU in listing attrs", async () => {
    const calls: Array<{ route: string; input: any }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const route = new URL(String(url)).pathname.replace("/rpc/", "");
      const input = JSON.parse(String(init?.body)).json;
      calls.push({ route, input });
      if (route === "product/enrich") return json({ productId: "product-1", companyId: "company-1", matchedBy: "created", observationSkipped: null });
      if (route === "product/submitFacts") return json({ decision: "recorded", factsHash: "facts-1" });
      if (route === "product/getById") return json({ id: "product-1", name: "Vitamin C 60 Count" });
      return json({ message: "not found" }, 404);
    };
    const api = new SupplySmartApi({ baseUrl: "http://jakarta.local", fetchImpl: fetchImpl as typeof fetch, retries: 0 });
    const result = await api.ingestAndValidate(batch);

    expect(result.problems).toEqual([]);
    expect(result.verified).toBe(1);
    expect(calls.map((call) => call.route)).toEqual(["product/enrich", "product/submitFacts", "product/getById"]);
    expect(calls[0]?.input.variantAttrs).toMatchObject({ sku: "VC-60", skuMissing: false, pack: "60 Count" });
    expect(calls[1]?.input.productId).toBe("product-1");
  });

  it("refuses to report success when Jakarta cannot match the company domain", async () => {
    const api = new SupplySmartApi({
      baseUrl: "http://jakarta.local",
      retries: 0,
      fetchImpl: (async (url: string | URL | Request) => {
        const route = new URL(String(url)).pathname.replace("/rpc/", "");
        if (route === "product/enrich") return json({ productId: "product-1", companyId: null, matchedBy: "created", observationSkipped: null });
        return json({ id: "product-1" });
      }) as typeof fetch,
    });
    const result = await api.ingestAndValidate(batch);
    expect(result.verified).toBe(0);
    expect(result.problems[0]).toContain("公司域名未匹配");
  });

  it("resolves an Amazon brand through a unique Jakarta company search result", async () => {
    const api = new SupplySmartApi({
      baseUrl: "http://jakarta.local",
      retries: 0,
      fetchImpl: (async (url: string | URL | Request) => {
        const route = new URL(String(url)).pathname.replace("/rpc/", "");
        if (route === "company/getByExactName") return json({ message: "not found" }, 404);
        if (route === "company/search") return json({ data: [{ id: "company-1", name: "NOW Foods" }], total: 1, page: 1, pageSize: 20 });
        if (route === "company/getById") return json({ id: "company-1", name: "NOW Foods", website: "https://www.nowfoods.com/products" });
        return json({ message: "not found" }, 404);
      }) as typeof fetch,
    });
    await expect(api.resolveCompanyDomain("NOW Foods Store")).resolves.toBe("nowfoods.com");
  });
});
