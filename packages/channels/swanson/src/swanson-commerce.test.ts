import { describe, expect, it } from "vitest";
import { swansonAdapter } from "./adapter.js";

const url = "https://www.swansonvitamins.com/p/test-extract";
const productUrl = url.replace("/p/", "/products/");
const capturedAt = "2026-10-01T00:00:00.000Z";
const product = {
  id: 123,
  handle: "test-extract",
  variants: [{ id: 456, price: 1678, sku: "TEST001" }],
};
const metadata = (value: unknown = product) =>
  `<script>var meta = ${JSON.stringify({ product: value })};</script>`;
const offer = {
  "@type": "Offer",
  url: `${productUrl}?variant=456`,
  availability: "https://schema.org/OutOfStock",
  price: "16.78",
  priceCurrency: "USD",
};
const schema = (offers: unknown = offer) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@type": ["Product", "DietarySupplement"],
    url: productUrl,
    offers,
  })}</script>`;
const notice = "<div>We're sorry, but this item is currently sold out.</div>";
const notify = '<form class="cordial-bis-form"><button>Notify Me</button></form>';
const detail = `<div data-cnstrc-product-detail data-product-id="123" data-variant-id="456"
  data-url="${url}" data-cnstrc-item-price="16.78">
  <h1>Test Extract</h1>${notice}${notify}</div>`;
// Synthetic structure: no saved HTML or page scripts, and no cart form or variant picker.
const html = `<link rel="canonical" href="${url}">${metadata()}<main>${detail}</main>${schema()}`;
const read = (source = html) => swansonAdapter.parseProduct({ html: source, url, capturedAt });
const withoutText = html.replace(notice, "").replace(notify, "");
const withoutStock = withoutText.replace(schema(), "");

describe("Swanson product-owned sold-out commerce", () => {
  it("reads the real no-cart/no-picker structure through the full adapter", () => {
    const parsed = read();
    expect(parsed.identity).toEqual({ listingId: "123", variantId: "456" });
    expect(parsed.evidence.title).toBe("Test Extract");
    expect(parsed.commerce).toEqual({
      codec: "public-product-commerce/1",
      sku: null,
      price: "16.78",
      currency: "USD",
      listPrice: null,
      rating: null,
      reviewCount: null,
      availability: "OutOfStock",
      context: [],
    });
  });

  it.each([
    ["sold-out text", notice],
    ["out-of-stock badge", "<span>Out of stock</span>"],
    [
      "manufacturer stock notice",
      "<div>We're sorry, this item is currently unavailable " +
        "due to a manufacturer stock issue.</div>",
    ],
    ["back-in-stock notification form", notify],
    ["microdata", '<link itemprop="availability" href="https://schema.org/OutOfStock">'],
  ])("accepts the product's %s without JSON-LD", (_name, signal) => {
    expect(read(withoutStock.replace("</h1>", `</h1>${signal}`)).commerce?.availability).toBe(
      "OutOfStock",
    );
  });

  it.each([true, false])(
    "reads selected variant available=%s with its cents price",
    (available) => {
      const source = withoutStock.replace(
        metadata(),
        metadata({
          ...product,
          variants: [{ id: 456, available, price: 1678 }],
        }),
      );
      expect(read(source).commerce).toMatchObject({
        availability: available ? "InStock" : "OutOfStock",
        price: "16.78",
        currency: null,
      });
    },
  );

  it.each([true, false])("reads sole-product available=%s", (available) => {
    const source = withoutStock.replace(metadata(), metadata({ ...product, available }));
    expect(read(source).commerce?.availability).toBe(available ? "InStock" : "OutOfStock");
  });

  it("does not coerce a malformed Shopify availability flag", () => {
    const source = withoutStock.replace(
      metadata(),
      metadata({
        ...product,
        variants: [{ id: 456, available: "false", price: 1678 }],
      }),
    );
    expect(read(source).commerce?.availability).toBeNull();
    expect(read(source).commerce?.context.join("\n")).toContain(
      "unrecognized product-owned signal",
    );
  });

  it("reads the selected schema offer without a visible stock message", () => {
    expect(read(withoutText).commerce?.availability).toBe("OutOfStock");
    const source = withoutText.replace(
      schema(),
      schema({ ...offer, availability: "https://schema.org/InStock" }),
    );
    expect(read(source).commerce?.availability).toBe("InStock");
  });

  it.each([
    [
      "visible notice versus schema",
      html.replace(schema(), schema({ ...offer, availability: "https://schema.org/InStock" })),
    ],
    [
      "Shopify versus schema",
      withoutText.replace(
        metadata(),
        metadata({ ...product, variants: [{ id: 456, available: true, price: 1678 }] }),
      ),
    ],
    [
      "two offers for the selected variant",
      withoutText.replace(
        schema(),
        schema([offer, { ...offer, availability: "https://schema.org/InStock" }]),
      ),
    ],
    [
      "microdata versus schema",
      withoutText.replace("</h1>", '</h1><meta itemprop="availability" content="InStock">'),
    ],
  ])("leaves conflicting %s unknown with evidence", (_name, source) => {
    const commerce = read(source).commerce;
    expect(commerce?.availability).toBeNull();
    expect(commerce?.context.join("\n")).toContain("conflicting product-owned signals");
    expect(commerce?.price).toBe("16.78");
  });

  it("records why stock is absent instead of inferring it from a price", () => {
    expect(read(withoutStock).commerce).toMatchObject({
      availability: null,
      price: "16.78",
      context: ["availability: no product-owned signal observed"],
    });
  });

  it("keeps unsupported schema states unknown", () => {
    const source = withoutText.replace(
      schema(),
      schema({ ...offer, availability: "https://schema.org/PreOrder" }),
    );
    expect(read(source).commerce?.availability).toBeNull();
    expect(read(source).commerce?.context.join("\n")).toContain(
      "unrecognized product-owned signal",
    );
  });
});

describe("Swanson commerce ownership and prices", () => {
  it.each(["constructor-recommendations", "product-recommendations", "product-card"])(
    "ignores %s stock, prices, metadata, JSON-LD and selected plans",
    (tag) => {
      const recommendation = `<${tag}><span>In stock</span>
        <meta itemprop="availability" content="InStock"><meta itemprop="price" content="0.01">
        <div class="product-form-plan-option selected">
          <span class="product-form-plan-option-price--current">$0.01</span></div>
        ${metadata()}${schema({ ...offer, price: "0.01", availability: "InStock" })}</${tag}>`;
      expect(read(html.replace("</h1>", `</h1>${recommendation}`)).commerce).toEqual(
        read().commerce,
      );
      expect(
        read(withoutStock.replace("</h1>", `</h1>${recommendation}`)).commerce?.availability,
      ).toBeNull();
    },
  );

  it.each([
    ["another variant", `${productUrl}?variant=999`],
    ["duplicate variant parameters", `${productUrl}?variant=456&variant=999`],
    ["another product", "https://www.swansonvitamins.com/products/another?variant=456"],
    ["another host", "https://example.com/products/test-extract?variant=456"],
    ["no selected variant", productUrl],
  ])("does not use an offer for %s", (_name, target) => {
    const source = withoutText.replace(schema(), schema({ ...offer, url: target, price: "0.01" }));
    expect(read(source).commerce).toMatchObject({
      price: "16.78",
      availability: null,
      currency: null,
    });
  });

  it("does not use another schema product even when its offer mimics this variant", () => {
    const foreignSchema = schema().replace(
      `"url":"${productUrl}"`,
      '"url":"https://www.swansonvitamins.com/products/another"',
    );
    expect(read(withoutText.replace(schema(), foreignSchema)).commerce?.availability).toBeNull();
  });

  it.each([
    "<div hidden><span>In stock</span></div>",
    '<div aria-hidden="true"><span>In stock</span></div>',
    '<div style="display:none"><span>In stock</span></div>',
    '<div class="hidden"><span>In stock</span></div>',
    "<details><summary>Product Details</summary><p>In stock</p></details>",
  ])("does not read hidden or descriptive stock text: %s", (extra) => {
    expect(read(html.replace("</h1>", `</h1>${extra}`)).commerce?.availability).toBe("OutOfStock");
  });

  it("leaves conflicting owned prices null with a reason", () => {
    const source = html.replace(schema(), schema({ ...offer, price: "17.00" }));
    expect(read(source).commerce).toMatchObject({
      price: null,
      availability: "OutOfStock",
      context: ["price: conflicting product-owned prices or currencies"],
    });
  });

  it("does not fabricate a currency for a Shopify cents-only price", () => {
    const source = html.replace(schema(), "").replace(' data-cnstrc-item-price="16.78"', "");
    expect(read(source).commerce).toMatchObject({ price: "16.78", currency: null });
  });

  it("keeps a printed own-product price verbatim when it agrees with structured data", () => {
    const source = html.replace("</h1>", '</h1><span itemprop="price">$16.78</span>');
    expect(read(source).commerce).toMatchObject({ price: "$16.78", currency: "USD" });
  });

  it("does not use another variant's price or available flag in picker JSON", () => {
    const picker = `<variant-picker data-product-id="123"><input type="radio" checked
      data-variant-id="456"><script type="application/json">
      {"id":999,"available":true,"price":1}</script></variant-picker>`;
    const source = html.replace("</h1>", `</h1>${picker}`);
    expect(read(source).commerce).toEqual(read().commerce);
  });

  it("preserves an absent price", () => {
    const source = html
      .replace(schema(), "")
      .replace(' data-cnstrc-item-price="16.78"', "")
      .replace(metadata(), metadata({ ...product, variants: [{ id: 456 }] }));
    expect(read(source).commerce).toMatchObject({ price: null, availability: "OutOfStock" });
  });
});

describe("Swanson existing in-stock cart-form compatibility", () => {
  const cart = `<product-form-component data-product-id="123">
    <input name="id" value="456"></product-form-component>`;
  const plan = `<div class="product-form-plan-option selected">
    <span class="product-form-plan-option-price--current">$14.00</span></div>`;
  const picker = `<variant-picker data-product-id="123"><input role="radio" checked
    name="Size" value="1 fl oz" data-connected-product-url="/p/test-extract"
    data-variant-id="456" data-option-available="true"></variant-picker>`;
  const inStock = withoutText
    .replace(schema(), schema({ ...offer, availability: "InStock" }))
    .replace("</h1>", `</h1>${cart}${plan}`);

  it.each([
    ["single size", "", null],
    ["selected size", picker, "InStock"],
  ])(
    "keeps the existing %s commerce exactly, including its selected price",
    (_name, choice, availability) => {
      const source = inStock.replace("</h1>", `</h1>${choice ?? ""}`);
      expect(read(source).commerce).toEqual({
        codec: "public-product-commerce/1",
        sku: null,
        price: "$14.00",
        currency: null,
        listPrice: null,
        rating: null,
        reviewCount: null,
        availability,
        context: ["selected: $14.00"],
      });
    },
  );

  it("still reports contradictory stock when a normal cart form exists", () => {
    const source = inStock.replace("</h1>", `</h1>${picker}${notice}`);
    expect(read(source).commerce?.availability).toBeNull();
    expect(read(source).commerce?.context.join("\n")).toContain(
      "conflicting product-owned signals",
    );
  });
});
