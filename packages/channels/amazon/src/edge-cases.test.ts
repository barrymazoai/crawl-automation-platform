import { beforeAll, describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { amazonAdapter, type AmazonRendered } from "./index.js";
import type { ParsedProduct } from "@crawl-automation/channels-core";
import { savedPage, savedPaths } from "./testing/saved-pages.js";

const fixture = savedPage(savedPaths.fish);
const edit = (change: (document: ReturnType<typeof parseHTML>["document"]) => void) => {
  const page = fixture.read();
  const document = parseHTML(page.html).document;
  change(document);
  return { ...page, html: document.toString() };
};

describe.skipIf(!fixture.available)(
  `${fixture.name}: identity, metrics and image boundaries`,
  () => {
    let parsed: ParsedProduct<AmazonRendered>;
    beforeAll(() => {
      parsed = amazonAdapter.parseProduct(fixture.read());
    });

    it("reports the page ASIN even when the requested URL names a different product", () => {
      const page = { ...fixture.read(), url: "https://www.amazon.com/dp/B0G963NB8Q" };
      expect(amazonAdapter.pageIdentity?.(page)).toEqual({
        listingId: fixture.asin,
        variantId: null,
      });
      expect(amazonAdapter.parseProduct(page).identity.listingId).toBe(fixture.asin);
    });

    it("rejects contradictory selected ASIN fields instead of guessing from the URL", () => {
      const page = edit((document) => {
        document.querySelector("#ppd input#ASIN")?.setAttribute("value", "B0G963NB8Q");
      });
      expect(() => amazonAdapter.parseProduct(page)).toThrow(
        expect.objectContaining({ code: "AMAZON.ASIN_CONFLICT" }),
      );
    });

    it("never promotes recommendation ASINs when the selected ASIN is absent", () => {
      const page = edit((document) => {
        document
          .querySelectorAll('#ppd input#ASIN, #ppd input[name="ASIN"]')
          .forEach((node) => node.remove());
        document
          .querySelectorAll("#ppd #title_feature_div, #ppd #twister_feature_div")
          .forEach((node) => node.removeAttribute("data-csa-c-asin"));
        document
          .querySelectorAll("#ppd #all-offers-display-params")
          .forEach((node) => node.removeAttribute("data-asin"));
      });
      expect(() => amazonAdapter.parseProduct(page)).toThrow(
        expect.objectContaining({ code: "AMAZON.PRODUCT_UNVERIFIED" }),
      );
    });

    it.each(["channel", "listingId", "variantId", "url"])(
      "rejects a mismatched planning %s",
      (field) => {
        const replacements = {
          channel: "gnc",
          listingId: "B0G963NB8Q",
          variantId: "variant",
          url: "https://www.amazon.com/dp/B0G963NB8Q",
        };
        const projection = {
          ...parsed.evidence,
          [field]: replacements[field as keyof typeof replacements],
        };
        expect(() =>
          amazonAdapter.planning?.read(projection, fixture.read().url, parsed.identity),
        ).toThrow(expect.objectContaining({ code: "AMAZON.ASIN_CONFLICT" }));
      },
    );

    it("checks the expected URL and owner when reading a retained projection", () => {
      const read = amazonAdapter.planning?.read;
      expect(() =>
        read?.(parsed.evidence, "https://www.amazon.com/dp/B0G963NB8Q", parsed.identity),
      ).toThrow(expect.objectContaining({ code: "AMAZON.ASIN_CONFLICT" }));
      expect(() =>
        read?.(parsed.evidence, fixture.read().url, { listingId: "B0G963NB8Q", variantId: null }),
      ).toThrow(expect.objectContaining({ code: "AMAZON.ASIN_CONFLICT" }));
    });

    it("never fills missing metrics from recommendations or individual reviews", () => {
      const page = edit((document) => {
        document
          .querySelectorAll("#ppd #averageCustomerReviews, #ppd #acrPopover")
          .forEach((node) => node.remove());
      });
      expect(amazonAdapter.parseProduct(page).commerce).toMatchObject({
        rating: null,
        reviewCount: null,
      });
    });

    it("leaves the price absent when only subscription or recommendation prices remain", () => {
      const page = edit((document) => {
        document
          .querySelectorAll("#ppd .priceToPay, #ppd #corePrice_feature_div")
          .forEach((node) => node.remove());
      });
      expect(amazonAdapter.parseProduct(page).commerce).toMatchObject({
        price: null,
        currency: null,
        priceStatus: "not_observed",
      });
    });

    it("records conflicting one-time offer prices as ambiguous", () => {
      const page = edit((document) => {
        document
          .querySelector("#ppd #corePriceDisplay_desktop_feature_div")
          ?.insertAdjacentHTML(
            "beforeend",
            '<span class="priceToPay"><span class="a-offscreen">$22.22</span></span>',
          );
      });
      expect(amazonAdapter.parseProduct(page).commerce).toMatchObject({
        price: null,
        priceStatus: "ambiguous",
      });
    });

    it("prefers observed large images when hiRes is unavailable", () => {
      const page = fixture.read();
      const html = page.html.replaceAll(
        '"hiRes":"https://m.media-amazon.com/images/I/71m62G2Sr3L._AC_SL1500_.jpg"',
        '"hiRes":null',
      );
      expect(amazonAdapter.parseProduct({ ...page, html }).evidence.imageCandidates[0]?.url).toBe(
        "https://m.media-amazon.com/images/I/41t8dKyVZ+L._AC_.jpg",
      );
    });

    it("uses the main DOM gallery when embedded gallery data cannot be read", () => {
      const page = edit((document) => {
        document.querySelectorAll("script").forEach((node) => {
          if (node.textContent?.includes("colorImages")) {
            node.textContent = "var broken = { colorImages:";
          }
        });
      });
      const product = amazonAdapter.parseProduct(page);
      expect(product.evidence.warnings).toContain("AMAZON.SCRIPT_DATA_UNREADABLE");
      expect(
        product.evidence.imageCandidates.some((image) => image.url.includes("71m62G2Sr3L")),
      ).toBe(true);
      expect(
        product.evidence.imageCandidates.every((image) =>
          image.url.startsWith("https://m.media-amazon.com/images/I/"),
        ),
      ).toBe(true);
    });
  },
);

describe("unreadable Amazon pages", () => {
  it("refuses an actual challenge without treating it as an unlisted product", () => {
    expect(() =>
      amazonAdapter.parseProduct({
        url: "https://www.amazon.com/dp/B0013LAQS6",
        html: '<title>Robot Check</title><form action="/errors/validateCaptcha"></form>',
        capturedAt: "2026-09-23T00:00:00.000Z",
      }),
    ).toThrow(expect.objectContaining({ code: "CAPTURE.ACCESS_CHALLENGE" }));
  });
});

describe.skipIf(!fixture.available)(`${fixture.name}: inert scripts`, () => {
  it("reads script data without running JavaScript or requesting script URLs", () => {
    const page = edit((document) => {
      const script = document.createElement("script");
      script.textContent =
        'throw new Error("Page script must never execute");' +
        'fetch("https://example.invalid/paid"); var unused = {colorImages: {other: []}};';
      document.body.append(script);
    });
    expect(amazonAdapter.parseProduct(page).evidence.imageCandidates).toEqual(
      amazonAdapter.parseProduct(fixture.read()).evidence.imageCandidates,
    );
  });
});
