import { describe, expect, it } from "vitest";
import { amazonAdapter, amazonProductAddress } from "./index.js";

describe("Amazon HTTP product addresses", () => {
  it.each([
    "https://www.amazon.com/dp/B0013LAQS6?th=1&psc=1",
    "https://amazon.com/Natures-Bounty-Fish-Oil/dp/B0013LAQS6/ref=abc#details",
    "http://smile.amazon.com/gp/product/B0013LAQS6?tag=affiliate",
    "https://m.amazon.com/gp/aw/d/B0013LAQS6/ref=abc",
    "https://www.amazon.com/-/en/Natures-Bounty/dp/B0013LAQS6",
    "https://www.amazon.com/gp/offer-listing/B0013LAQS6",
    "/dp/b0013laqs6",
  ])("normalizes %s", (url) => {
    expect(amazonProductAddress(url)).toEqual({
      url: "https://www.amazon.com/dp/B0013LAQS6",
      listingId: "B0013LAQS6",
      variantId: null,
    });
  });

  it.each([
    "https://www.amazon.com.evil.test/dp/B0013LAQS6",
    "https://www.amazon.com@evil.test/dp/B0013LAQS6",
    "https://user:password@www.amazon.com/dp/B0013LAQS6",
    "https://www.amazon.com:444/dp/B0013LAQS6",
    "ftp://www.amazon.com/dp/B0013LAQS6",
    "https://www.amazon.com/dp/B0013LAQS60",
    "https://www.amazon.com/s?k=B0013LAQS6",
    "https://www.amazon.com/stores/page/ABC",
    "https://www.amazon.com/clp/B0013LAQS6",
  ])("rejects %s with core's URL code", (url) => {
    expect(() => amazonProductAddress(url)).toThrow(
      expect.objectContaining({ code: "CHANNEL.URL_REJECTED" }),
    );
  });

  it("declares bounded HTTP capture and a planning hook, with no Store scanner", () => {
    expect(amazonAdapter.captureModes).toEqual(["http"]);
    expect(amazonAdapter.httpPolicy).toEqual({
      origins: ["https://www.amazon.com"],
      maxBytes: 6 * 1024 * 1024,
      timeoutMs: 75_000,
    });
    expect(amazonAdapter.planning?.channel).toBe("amazon");
    expect(amazonAdapter.brandScan?.maxPages).toBe(7);
  });
});
