import { appErrors } from "@crawl-automation/app";
import { artifactErrors } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { appWith, post, query } from "../testing/app-with.js";

const result = {
  operationId: "saved-operation",
  channel: "swanson",
  listingId: "product",
  variantId: null,
  capturedAt: "2026-09-30T01:00:00.000Z",
  url: "https://example.com/product",
  sha256: "a".repeat(64),
  byteSize: 18,
  mediaType: "text/html",
  html: "<html>saved</html>",
};

describe("evidence.original query", () => {
  it.each([
    { operationId: "saved-operation" },
    { channel: "swanson", listingId: "product" },
    { channel: "swanson", listingId: "product", variantId: "large" },
    { channel: "swanson", listingId: "product", variantId: null },
  ])(
    "passes %j to the service and returns the complete original without authentication",
    async (input) => {
      const original = vi.fn(async () => result);
      const response = await appWith({ originals: { original } }).request(
        `/trpc/evidence.original${query(input)}`,
      );
      expect(response.status).toBe(200);
      expect((await response.json()).result.data).toEqual(result);
      expect(original).toHaveBeenCalledExactlyOnceWith(input);
    },
  );

  it.each([
    {},
    { operationId: "" },
    { operationId: "x".repeat(201) },
    { channel: "unknown", listingId: "product" },
    { channel: "gnc" },
    { channel: "gnc", listingId: "" },
    { channel: "gnc", listingId: "product", variantId: "" },
    { operationId: "saved-operation", channel: "gnc", listingId: "product" },
    { operationId: "saved-operation", extra: true },
  ])("rejects invalid or ambiguous input %j before reading", async (input) => {
    const original = vi.fn();
    const response = await appWith({ originals: { original } }).request(
      `/trpc/evidence.original${query(input)}`,
    );
    expect(response.status).toBe(400);
    expect(original).not.toHaveBeenCalled();
  });

  it.each([
    [appErrors.create("EVIDENCE.NOT_FOUND"), 404, "NOT_FOUND"],
    [artifactErrors.create("ARTIFACT.INTEGRITY"), 500, "INTERNAL_SERVER_ERROR"],
  ] as const)("maps registered failures to tRPC", async (failure, status, code) => {
    const original = vi.fn().mockRejectedValue(failure);
    const response = await appWith({ originals: { original } }).request(
      `/trpc/evidence.original${query({ operationId: "saved-operation" })}`,
    );
    expect(response.status).toBe(status);
    expect((await response.json()).error.data).toMatchObject({ code, app: { code: failure.code } });
  });

  it("is a query, never a mutation", async () => {
    const original = vi.fn();
    const response = await appWith({ originals: { original } }).request(
      "/trpc/evidence.original",
      post({ operationId: "saved-operation" }),
    );
    expect(response.status).toBe(405);
    expect(original).not.toHaveBeenCalled();
  });
});
