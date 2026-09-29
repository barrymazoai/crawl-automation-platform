import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { swansonAdapter } from "./adapter.js";

/** Real pages archived by the Healthy Origins pilot on 2026-09-28 (see fixtures/README.md). */
function page(file: string, url: string) {
  const html = gunzipSync(readFileSync(new URL(`./fixtures/${file}`, import.meta.url))).toString(
    "utf8",
  );
  return { url, html, capturedAt: "2026-09-28T23:45:00.000Z" };
}

const riboseUrl = "https://www.swansonvitamins.com/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr";
const ubiquinolUrl =
  "https://www.swansonvitamins.com/p/healthy-origins-ubiquinol-kaneka-qh-100-mg-60-sgels?variant=46318812168330";

describe("swansonAdapter.productAddress", () => {
  it("reads the handle and the selected variant from the URL", () => {
    expect(swansonAdapter.productAddress(ubiquinolUrl)).toEqual({
      url: ubiquinolUrl,
      listingId: "healthy-origins-ubiquinol-kaneka-qh-100-mg-60-sgels",
      variantId: "46318812168330",
    });
  });

  it("refuses another site's URL", () => {
    expect(() => swansonAdapter.productAddress("https://www.amazon.com/dp/B000000001")).toThrow();
  });
});

describe("swansonAdapter.parseProduct on real archived pages", () => {
  it("reads a single-size product: identity, title, price and complete facts text", () => {
    const parsed = swansonAdapter.parseProduct(page("healthy-origins-d-ribose.html.gz", riboseUrl));

    expect(parsed.channel).toBe("swanson");
    expect(parsed.evidence.listingId).toMatch(/^\d+$/);
    expect(parsed.evidence.variantId).toMatch(/^\d+$/);
    expect(parsed.evidence.title).toMatch(/D-Ribose/i);
    expect(parsed.commerce?.price).toMatch(/^\$\d/);
    expect(parsed.variants.length).toBeGreaterThanOrEqual(1);
    expect(parsed.facts.text).toMatch(/Serving Size/i);
  });

  it("reads a page opened on one of several sizes, with every size as its own address", () => {
    const parsed = swansonAdapter.parseProduct(
      page("healthy-origins-ubiquinol-variant.html.gz", ubiquinolUrl),
    );

    expect(parsed.evidence.title).toMatch(/Ubiquinol/i);
    expect(parsed.evidence.variantId).toBe("46318812168330");
    expect(parsed.variants.map((variant) => variant.variantId)).toContain("46318812168330");
    for (const variant of parsed.variants) {
      expect(swansonAdapter.productAddress(variant.url)).toEqual(variant);
    }
  });

  it("reports whether the facts text alone is enough for a formula, with reasons when not", () => {
    for (const [file, url] of [
      ["healthy-origins-d-ribose.html.gz", riboseUrl],
      ["healthy-origins-ubiquinol-variant.html.gz", ubiquinolUrl],
    ] as const) {
      const { facts } = swansonAdapter.parseProduct(page(file, url));
      expect(facts.complete).toBe(facts.missing.length === 0);
    }
  });
});
