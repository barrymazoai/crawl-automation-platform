import { describe, expect, it, vi } from "vitest";
import { appWith, post } from "./testing/app-with.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const brandId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const source = {
  channel: "costco",
  region: "US",
  url: "https://www.costco.com/vitamins-herbals-dietary-supplements.html",
};

describe("brand procedures", () => {
  it.each([
    ["create", { requestId, name: "Nordic Naturals" }],
    ["update", { requestId, brandId, name: "Nordic Naturals", note: "", revision: 1 }],
    ["createSource", { requestId, brandId, ...source }],
    ["updateSource", { requestId, brandId, sourceId, ...source, revision: 1 }],
    // Disabling a source is toggleSource with enabled false.
    ["toggleSource", { requestId, brandId, sourceId, enabled: false, revision: 2 }],
  ])("brands.%s reaches the brand service", async (method, input) => {
    const call = vi.fn(async () => ({ id: sourceId }));
    const response = await appWith({ brands: { [method]: call } }).request(
      `/trpc/brands.${method}`,
      post(input),
    );
    expect(response.status).toBe(200);
    expect(call).toHaveBeenCalledWith(expect.objectContaining(input));
  });

  it("accepts a source on every channel, Whole Foods and Costco included", async () => {
    const createSource = vi.fn(async () => ({ id: sourceId }));
    for (const channel of ["wholefoods", "costco"]) {
      const response = await appWith({ brands: { createSource } }).request(
        "/trpc/brands.createSource",
        post({ requestId, brandId, ...source, channel }),
      );
      expect(response.status).toBe(200);
    }
  });

  it("refuses an unknown channel before any service runs", async () => {
    const createSource = vi.fn();
    const response = await appWith({ brands: { createSource } }).request(
      "/trpc/brands.createSource",
      post({ requestId, brandId, ...source, channel: "walmart" }),
    );
    expect(response.status).toBe(400);
    expect(createSource).not.toHaveBeenCalled();
  });
});
