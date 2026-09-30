import { describe, expect, it, vi } from "vitest";
import { ProductService, type ProductDetail, type ProductStore } from "./product-service.js";

const detail: ProductDetail = {
  operationId: "op-1",
  sourceId: "s",
  listingId: "877080",
  variantId: null,
  collectedAt: "2026-09-30T00:00:00.000Z",
  formulaRows: 8,
  otherIngredients: 3,
  warningCodes: [],
  record: { formula: { rows: [] } },
};

function service(found: ProductDetail | null) {
  const products: ProductStore = {
    list: vi.fn(async () => ({ items: [detail], nextCursor: null })),
    get: vi.fn(async () => found),
  };
  return { products, service: new ProductService({ products }) };
}

describe("ProductService", () => {
  it("lists collected products as the store pages them", async () => {
    const { products, service: productService } = service(detail);
    const query = { limit: 50 };
    expect(await productService.list(query)).toEqual({ items: [detail], nextCursor: null });
    expect(products.list).toHaveBeenCalledWith(query);
  });

  it("answers one collected product with its full record", async () => {
    const { service: products } = service(detail);
    expect(await products.get("op-1")).toBe(detail);
  });

  it("refuses an unknown product", async () => {
    const { service: products } = service(null);
    await expect(products.get("op-2")).rejects.toMatchObject({ code: "PRODUCT.NOT_FOUND" });
  });
});
