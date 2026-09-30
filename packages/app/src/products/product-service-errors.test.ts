import { describe, expect, it, vi } from "vitest";
import { ProductService, type ProductStore } from "./product-service.js";

describe("ProductService repository boundaries", () => {
  it("preserves filters, cursors and an empty page exactly", async () => {
    const page = { items: [], nextCursor: "next-page" };
    const products: ProductStore = { list: vi.fn(async () => page), get: vi.fn() };
    const query = { sourceId: "source", listingId: "listing", before: "cursor", limit: 1 };
    expect(await new ProductService({ products }).list(query)).toBe(page);
    expect(products.list).toHaveBeenCalledExactlyOnceWith(query);
    expect(products.get).not.toHaveBeenCalled();
  });

  it.each(["list", "get"] as const)(
    "propagates %s repository failures unchanged",
    async (method) => {
      const failure = Object.assign(new Error("offline"), { code: "STORE.OFFLINE" });
      const products: ProductStore = {
        list: vi.fn().mockRejectedValue(failure),
        get: vi.fn().mockRejectedValue(failure),
      };
      const service = new ProductService({ products });
      const result = method === "list" ? service.list({ limit: 50 }) : service.get("operation");
      await expect(result).rejects.toBe(failure);
      expect(products[method]).toHaveBeenCalledOnce();
    },
  );

  it("names the exact operation in PRODUCT.NOT_FOUND", async () => {
    const products: ProductStore = { list: vi.fn(), get: vi.fn(async () => null) };
    await expect(new ProductService({ products }).get("missing-operation")).rejects.toMatchObject({
      code: "PRODUCT.NOT_FOUND",
      details: { operationId: "missing-operation" },
    });
    expect(products.get).toHaveBeenCalledExactlyOnceWith("missing-operation");
  });
});
