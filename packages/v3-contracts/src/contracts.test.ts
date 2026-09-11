import { describe, expect, it, vi } from "vitest";
import {
  Brand,
  CreateBrand,
  CreateSource,
  UpdateBrand,
  ToggleSource,
  ListQuery,
  Summary,
  pageSchema,
} from "./index.js";

describe("V3 shared wire contracts", () => {
  it("creates a V3 identity without legacy/company compatibility", () => {
    expect(CreateBrand.parse({ name: " Sample " })).toEqual({
      name: "Sample",
      note: "",
    });
    for (const extra of [{ companyId: "old" }, { legacyId: "old" }])
      expect(CreateBrand.safeParse({ name: "Sample", ...extra }).success).toBe(
        false,
      );
  });
  it("validates and canonicalizes URLs without Node globals", () => {
    vi.stubGlobal("Buffer", undefined);
    try {
      expect(
        CreateSource.parse({
          channel: "dtc",
          region: "us",
          url: "https://EXAMPLE.COM:443/shop?q=1#label",
        }),
      ).toEqual({
        channel: "dtc",
        region: "US",
        url: "https://example.com/shop?q=1",
      });
      for (const url of [
        "javascript:alert(1)",
        "file:///tmp/a",
        "https://a:b@example.com/",
        "https://example.com/with space",
        "https:\\example.com",
        `https://example.com/${"中".repeat(230)}`,
      ]) {
        expect(CreateSource.safeParse({ channel: "dtc", url }).success).toBe(
          false,
        );
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("requires explicit edit revisions and boolean switches", () => {
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
  it("bounds pagination and names", () => {
    expect(ListQuery.parse({})).toEqual({ limit: 25, offset: 0, q: "" });
    expect(ListQuery.safeParse({ limit: "10000" }).success).toBe(false);
    expect(CreateBrand.safeParse({ name: "sample\0brand" }).success).toBe(
      false,
    );
  });
  it("requires JSON timestamps, not database Date objects or arbitrary strings", () => {
    const record = {
      id: "460a4ce5-a679-4409-a24e-e65d75cb3db2",
      name: "Sample",
      note: "",
      revision: 1,
      createdAt: "2026-09-05T00:00:00Z",
      updatedAt: "2026-09-05T00:00:00Z",
    };
    expect(Brand.parse(record)).toEqual(record);
    expect(Brand.safeParse({ ...record, createdAt: new Date() }).success).toBe(
      false,
    );
    expect(Brand.safeParse({ ...record, updatedAt: "yesterday" }).success).toBe(
      false,
    );
  });
  it("validates list and summary responses from the same schemas", () => {
    expect(
      pageSchema(Brand).parse({
        items: [],
        limit: 25,
        offset: 0,
        hasMore: false,
      }).items,
    ).toEqual([]);
    expect(
      Summary.safeParse({ brands: -1, sources: 0, enabledSources: 0 }).success,
    ).toBe(false);
  });
});
