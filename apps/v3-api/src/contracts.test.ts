import { describe, expect, it } from "vitest";
import {
  CreateBrand,
  CreateSource,
  UpdateBrand,
  ToggleSource,
  ListQuery,
} from "@crawl-automation/v3-contracts";
import { loadConfig } from "./bootstrap/config.js";

describe("V3-only HTTP contracts", () => {
  it("creates Brand identity without company or legacy fields", () => {
    expect(CreateBrand.parse({ name: " Sample " })).toEqual({
      name: "Sample",
      note: "",
    });
    for (const extra of [{ companyId: "old" }, { legacyId: "old" }])
      expect(CreateBrand.safeParse({ name: "Sample", ...extra }).success).toBe(
        false,
      );
  });
  it("canonicalizes URLs without changing query meaning", () => {
    expect(
      CreateSource.parse({
        channel: "dtc",
        region: "us",
        url: "https://EXAMPLE.COM:443/shop#label",
      }),
    ).toEqual({
      channel: "dtc",
      region: "US",
      url: "https://example.com/shop",
    });
    for (const url of [
      "javascript:alert(1)",
      "file:///tmp/a",
      "https://a:b@example.com/",
      "https://example.com/with space",
      "https:\\example.com",
    ])
      expect(CreateSource.safeParse({ channel: "dtc", url }).success).toBe(
        false,
      );
  });
  it("requires explicit edit versions and boolean switches", () => {
    expect(UpdateBrand.safeParse({ name: "Sample", note: "" }).success).toBe(
      false,
    );
    expect(
      ToggleSource.safeParse({ enabled: "false", revision: 1 }).success,
    ).toBe(false);
    expect(
      CreateSource.safeParse({
        channel: "dtc",
        url: "https://example.com",
        enabled: true,
      }).success,
    ).toBe(false);
  });
  it("bounds list queries and rejects control characters", () => {
    expect(ListQuery.parse({})).toEqual({ limit: 25, offset: 0, q: "" });
    expect(ListQuery.safeParse({ limit: "10000" }).success).toBe(false);
    expect(CreateBrand.safeParse({ name: "sample\0brand" }).success).toBe(
      false,
    );
  });
  it("cannot silently use the old database or a remote production target", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://old.example/old" }),
    ).toThrow();
    expect(() =>
      loadConfig({
        V3_DATABASE_URL: "postgres://127.0.0.1/old",
        V3_API_TOKEN: "x".repeat(32),
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        V3_DATABASE_URL: "postgres://remote.example/crawler_v3_dev",
        V3_API_TOKEN: "x".repeat(32),
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        V3_DATABASE_URL:
          "postgres://127.0.0.1/crawler_v3_dev?host=remote.example",
        V3_API_TOKEN: "x".repeat(32),
      }),
    ).toThrow();
    expect(
      loadConfig({
        V3_DATABASE_URL: "postgres://127.0.0.1/crawler_v3_dev",
        V3_API_TOKEN: "x".repeat(32),
      }).port,
    ).toBe(4180);
  });
});
