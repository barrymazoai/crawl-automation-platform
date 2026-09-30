import { appErrors } from "@crawl-automation/app";
import { describe, expect, it, vi } from "vitest";
import { appWith, query } from "./testing/app-with.js";

describe("product and history procedures", () => {
  it("answers one collected product with its full record", async () => {
    const product = { operationId: "op-1", record: { formula: {} } };
    const get = vi.fn(async () => product);
    const response = await appWith({ products: { get } }).request(
      `/trpc/products.get${query({ operationId: "op-1" })}`,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).result.data).toEqual(product);
    expect(get).toHaveBeenCalledWith("op-1");
  });

  it("answers 404 for an unknown product", async () => {
    const get = vi.fn(async () => {
      throw appErrors.create("PRODUCT.NOT_FOUND");
    });
    const response = await appWith({ products: { get } }).request(
      `/trpc/products.get${query({ operationId: "op-2" })}`,
    );
    expect(response.status).toBe(404);
  });

  it("reads a listing's metrics history by channel and product ID", async () => {
    const answer = { listings: [], points: [] };
    const list = vi.fn(async () => answer);
    const input = { channel: "wholefoods", externalId: "B002CQU54Q" };
    const response = await appWith({ history: { list } }).request(
      `/trpc/history.list${query(input)}`,
    );
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ ...input, kind: "metrics", limit: 100 });
  });

  it("refuses an unknown channel before any service runs", async () => {
    const list = vi.fn();
    const response = await appWith({ history: { list } }).request(
      `/trpc/history.list${query({ channel: "walmart", externalId: "1" })}`,
    );
    expect(response.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });
});
