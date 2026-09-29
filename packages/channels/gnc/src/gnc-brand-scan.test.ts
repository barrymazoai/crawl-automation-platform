import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { gncBrandScan } from "./gnc-brand-scan.js";

const body = gunzipSync(
  readFileSync(new URL("./fixtures/brand-gnc-page-1.html.gz", import.meta.url)),
).toString("utf8");
const url = gncBrandScan.pageUrl("https://www.gnc.com/brands/gnc/", 1);

describe("GNC brand scan on the real GNC house-brand page", () => {
  const page = gncBrandScan.parsePage({ body, url, page: 1 });

  it("reads every product tile, SKUs and families, and the brand total the page states", () => {
    expect(page.cards).toBe(200);
    expect(page.statedTotal).toBe(585);
    expect(
      page.products
        .filter((product) => product.kind === "family")
        .map((product) => product.listingId),
    ).toEqual(expect.arrayContaining(["GNCTotalLeanLeanShake12Pack", "leanShakeBurn12Pack"]));
    expect(page.products.find((product) => product.listingId === "734363")).toMatchObject({
      kind: "product",
      url: expect.stringMatching(/^https:\/\/www\.gnc\.com\/.+\/734363\.html$/),
    });
  });

  it("continues on page 2, and one page is not a full scan of 585 products", () => {
    expect(page.nextPage).toBe(2);
    expect(gncBrandScan.complete([page])).toBe(false);
  });

  it("is a full scan only when the pages read add up to the stated total and there is no next page", () => {
    const last = { products: [], cards: 185, nextPage: null, statedTotal: 585 };
    const middle = { products: [], cards: 200, nextPage: 3, statedTotal: 585 };
    expect(gncBrandScan.complete([page, middle, last])).toBe(true);
    expect(gncBrandScan.complete([page, { ...last, cards: 184 }])).toBe(false);
  });
});

describe("GNC brand listing addresses", () => {
  it("builds the newest-first page addresses of 200 products", () => {
    expect(url).toBe("https://www.gnc.com/brands/gnc/?srule=new-arrivals&start=0&sz=200");
    expect(gncBrandScan.pageUrl("https://www.gnc.com/brands/gnc/", 3)).toContain("start=400");
  });

  it.each(["https://www.gnc.com/vitamin-d/877080.html", "https://www.example.com/brands/gnc/"])(
    "refuses %s as a brand source",
    (source) => {
      expect(() => gncBrandScan.sourceUrl(source)).toThrow(
        expect.objectContaining({ code: "BRAND_SCAN.URL" }),
      );
    },
  );

  it("names a human-verification page, never an empty brand", () => {
    const challenge = "<html><body><div id='px-captcha'></div>Press & Hold</body></html>";
    expect(() => gncBrandScan.parsePage({ body: challenge, url, page: 1 })).toThrow(
      expect.objectContaining({ code: "BRAND_SCAN.ACCESS_CHALLENGE" }),
    );
  });
});

describe("GNC family pages", () => {
  it("lists a family's member SKUs from its product group and option links", () => {
    const group = {
      "@type": "ProductGroup",
      hasVariant: [
        {
          "@type": "Product",
          sku: "350111",
          offers: { url: "https://www.gnc.com/protein/350111.html" },
        },
        { "@type": "Product", sku: "350112", url: "/protein/350112.html" },
      ],
    };
    const html = `<script type="application/ld+json">${JSON.stringify(group)}</script>
      <div class="product-variations"><a href="/protein/350113.html">Chocolate</a><a href="/sale/">Sale</a></div>`;
    const members = gncBrandScan.familyMembers?.({
      url: "https://www.gnc.com/protein/Family.html",
      html,
      capturedAt: "",
    });
    expect(members?.map((member) => member.listingId)).toEqual(["350111", "350112", "350113"]);
  });
});
