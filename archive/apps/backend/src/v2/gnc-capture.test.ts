import { describe, expect, it } from "vitest";
import { CapturedProductV1Schema } from "@crawl-automation/contracts";
import type { ExtractedGncProduct } from "../gnc/extract.js";
import { batchImagesRequired, gncInputKind, toCapturedProduct } from "./gnc-capture.js";

const COMPLETE_FACTS = `HTML FACTS TABLE
Serving Size 1 Capsule
Servings Per Container 30
Amount Per Serving | % Daily Value
Vitamin C 500 mg | 556%
Zinc 15 mg | 136%`;

function product(overrides: Partial<ExtractedGncProduct> = {}): ExtractedGncProduct {
  return {
    sku: "100001",
    mpn: null,
    title: "GNC Vitamin C 500mg",
    brand: "GNC",
    description: "Immune support",
    price: "19.99",
    currency: "USD",
    inStock: true,
    rating: 4.5,
    reviewCount: 12,
    images: ["https://img.example.com/1.jpg"],
    productUrl: "https://www.gnc.com/vitamin-c/100001.html",
    labelPdfUrl: null,
    family: null,
    variantAttrs: { size: "30 capsules" },
    detailText: "DETAILS",
    factsText: COMPLETE_FACTS,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("toCapturedProduct", () => {
  it("produces a contract-valid product with the HTML facts table as evidence", () => {
    const captured = toCapturedProduct(product());
    expect(CapturedProductV1Schema.safeParse(captured).success).toBe(true);
    expect(captured.factsEvidence.htmlTable).toContain("Serving Size");
    expect(captured.availability).toBe("in_stock");
    expect(captured.sourceFiles).toEqual(["products/100001.json"]);
  });

  it("leaves htmlTable null when the facts text is not a complete table", () => {
    const captured = toCapturedProduct(product({ factsText: "INGREDIENTS ACCORDION\nVitamin C." }));
    expect(CapturedProductV1Schema.safeParse(captured).success).toBe(true);
    expect(captured.factsEvidence.htmlTable).toBeNull();
  });
});

describe("batchImagesRequired", () => {
  it("skips the image lane when every product has complete HTML facts", () => {
    expect(batchImagesRequired([product(), product({ sku: "100002" })])).toBe(false);
  });

  it("requires the image lane when a product lacks HTML facts but has a label PDF", () => {
    expect(batchImagesRequired([product(), product({ sku: "100002", factsText: "", labelPdfUrl: "https://www.gnc.com/label.pdf" })])).toBe(true);
  });

  it("does not require images when a product lacks both facts and any evidence source", () => {
    expect(batchImagesRequired([product({ factsText: "", labelPdfUrl: null, images: [] })])).toBe(false);
  });
});

describe("gncInputKind", () => {
  it("classifies product, brand catalog, and search URLs", () => {
    expect(gncInputKind("https://www.gnc.com/vitamin-c/100001.html")).toBe("product");
    expect(gncInputKind("https://www.gnc.com/brands/gnc/")).toBe("brand_catalog");
    expect(gncInputKind("https://www.gnc.com/search?q=protein")).toBe("search");
  });
});

describe("BatchPublisher", () => {
  it("publishes on the batch boundary and resumes append-only after a restart", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { BatchPublisher } = await import("./batch-publisher.js");
    const { toCapturedProduct, batchImagesRequired } = await import("./gnc-capture.js");
    const workRoot = await mkdtemp(path.join(tmpdir(), "gnc-publisher-"));
    try {
      const registered: any[] = [];
      const options = {
        channel: "gnc", adapter: "gnc", sourceType: "sales_channel" as const,
        url: "https://www.gnc.com/brands/gnc/", runId: "9e098108-aab7-4c4e-8f47-27122de73590", workRoot,
        batchSize: 2,
        key: (product: any) => product.sku,
        toContract: toCapturedProduct,
        imagesRequired: batchImagesRequired,
        registerBatch: async (batch: unknown) => { registered.push(batch); },
      };
      const publisher = new BatchPublisher(options as any);
      await publisher.init();
      await publisher.add(product({ sku: "100001" }));
      await publisher.add(product({ sku: "100002" }));
      await publisher.add(product({ sku: "100003" }));
      await publisher.flush();
      expect(publisher.batchCount).toBe(2);
      expect(registered.map((batch) => [batch.batchId, batch.itemCount])).toEqual([
        ["batch-000001", 2],
        ["batch-000002", 1],
      ]);

      // 模拟重启重试：init 接续 ordinal、跳过已发布 SKU、幂等重放注册。
      const replayed: any[] = [];
      const resumed = new BatchPublisher({ ...options, registerBatch: async (batch: unknown) => { replayed.push(batch); } } as any);
      await resumed.init();
      expect(resumed.batchCount).toBe(2);
      expect(replayed.map((batch) => batch.batchId)).toEqual(["batch-000001", "batch-000002"]);
      await resumed.add(product({ sku: "100001" }));
      await resumed.add(product({ sku: "100004" }));
      await resumed.flush();
      expect(resumed.batchCount).toBe(3);
      expect(replayed.at(-1)).toMatchObject({ batchId: "batch-000003", itemCount: 1 });
    } finally {
      await rm(workRoot, { recursive: true, force: true });
    }
  });
});
