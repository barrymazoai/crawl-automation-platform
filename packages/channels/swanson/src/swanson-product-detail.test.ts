import { describe, expect, it } from "vitest";
import { swansonAdapter } from "./adapter.js";

const url = "https://www.swansonvitamins.com/p/test-extract";
const capturedAt = "2026-10-01T00:00:00.000Z";
const product = {
  id: 123,
  handle: "test-extract",
  vendor: "Test Botanicals",
  variants: [{ id: 456, name: "Test Extract", public_title: null, sku: "TST001" }],
};
const script = `<script>var meta = ${JSON.stringify({ product })};</script>`;
const detail = `<div class="product-information" data-cnstrc-product-detail
  data-product-id="123" data-variant-id="456" data-url="${url}">
  <h1>Test Extract</h1><form class="cordial-bis-form"><button>Notify Me</button></form>
  <slideshow-slide><div class="product-media">
    <img src="/cdn/shop/files/test.jpg" alt="Test Extract">
  </div></slideshow-slide>
  <details><summary>Product Facts</summary><p>Serving Size 1 Dropper</p>
    <p>Amount Per Serving</p><p>Extract 100 mg</p><p>Other Ingredients: Water.</p>
  </details></div>`;
const html = `<link rel="canonical" href="${url}">${script}<main>${detail}</main>`;
const page = (source = html) => ({ html: source, url, capturedAt });

describe("Swanson sold-out product detail without a cart form or picker", () => {
  it("binds the canonical handle, explicit detail selection and Shopify product JSON", () => {
    const parsed = swansonAdapter.parseProduct(page());
    expect(swansonAdapter.pageIdentity?.(page())).toEqual({
      listingId: "test-extract",
      variantId: "456",
    });
    expect(parsed.identity).toEqual({ listingId: "123", variantId: "456" });
    expect(parsed.evidence.title).toBe("Test Extract");
    expect(parsed.evidence.imageCandidates).toHaveLength(1);
    expect(parsed.facts.text).toContain("Extract 100 mg");
    expect(parsed.facts.complete).toBe(true);
    expect(parsed.variants).toEqual([{ url, listingId: "test-extract", variantId: null }]);
  });

  it.each([
    ["no metadata", html.replace(script, "")],
    ["metadata alone", html.replace(detail, "<h1>Test Extract</h1>")],
    ["missing detail product ID", html.replace('data-product-id="123"', "")],
    ["missing detail variant ID", html.replace('data-variant-id="456"', "")],
    ["missing detail URL", html.replace(`data-url="${url}"`, "")],
    ["no product heading", html.replace("<h1>Test Extract</h1>", "")],
    ["two products", html.replace(detail, detail + detail)],
    ["two metadata declarations", html + script],
    ["variant not in metadata", html.replace('data-variant-id="456"', 'data-variant-id="999"')],
    ["multiple variants", html.replace('"variants":[', '"variants":[{"id":789},')],
    [
      "no variants",
      html.replace(
        script,
        `<script>var meta = ${JSON.stringify({
          product: { ...product, variants: [] },
        })};</script>`,
      ),
    ],
  ])("refuses %s without guessing from the request", (_name, source) => {
    expect(() => swansonAdapter.pageIdentity?.(page(source))).toThrowError(
      expect.objectContaining({ code: "SWANSON.IDENTITY_UNVERIFIED" }),
    );
  });

  it.each([
    ["product ID", html.replace('data-product-id="123"', 'data-product-id="999"')],
    ["metadata handle", html.replace('"handle":"test-extract"', '"handle":"another"')],
    ["detail URL", html.replace(`data-url="${url}"`, 'data-url="/p/another"')],
  ])("reports conflicting %s with the registered identity reason", (_name, source) => {
    expect(() => swansonAdapter.parseProduct(page(source))).toThrowError(
      expect.objectContaining({ code: "SWANSON.IDENTITY_CONFLICT" }),
    );
  });

  it("reads the page's own identity even when the requested handle or variant differs", () => {
    const wrongHandle = { ...page(), url: "https://www.swansonvitamins.com/p/another" };
    expect(swansonAdapter.pageIdentity?.(wrongHandle)).toEqual({
      listingId: "test-extract",
      variantId: "456",
    });
    expect(() => swansonAdapter.parseProduct(wrongHandle)).toThrowError(
      expect.objectContaining({ code: "SWANSON.IDENTITY_CONFLICT" }),
    );
    expect(() =>
      swansonAdapter.parseProduct({ ...page(), url: `${url}?variant=999` }),
    ).toThrowError(expect.objectContaining({ code: "SWANSON.VARIANT_CONFLICT" }));
  });

  it("never selects a recommendation's detail container", () => {
    const recommended = detail.replace("<h1>Test Extract</h1>", "<h2>Test Extract</h2>");
    const source = html.replace(
      detail,
      `<h1>Different Product</h1>
      <constructor-recommendations>${recommended}</constructor-recommendations>`,
    );
    expect(() => swansonAdapter.pageIdentity?.(page(source))).toThrowError(
      expect.objectContaining({ code: "SWANSON.IDENTITY_UNVERIFIED" }),
    );
  });

  it.each(["constructor-recommendations", "product-recommendations", "product-card"])(
    "ignores forms and pickers belonging to %s",
    (tag) => {
      const recommendation = `<${tag}>
        <product-form-component data-product-id="999">
          <input name="id" value="789">
        </product-form-component>
        <variant-picker data-product-id="999">
          <input type="radio" role="radio" checked data-variant-id="789">
        </variant-picker></${tag}>`;
      const source = html.replace("</main>", recommendation + "</main>");
      expect(swansonAdapter.parseProduct(page(source)).identity).toEqual({
        listingId: "123",
        variantId: "456",
      });
      const onlyRecommendation = source.replace(detail, "<h1>Unverified Product</h1>");
      expect(() => swansonAdapter.pageIdentity?.(page(onlyRecommendation))).toThrowError(
        expect.objectContaining({ code: "SWANSON.IDENTITY_UNVERIFIED" }),
      );
    },
  );

  it("does not use detail metadata to override an unselected size picker", () => {
    const picker =
      '<variant-picker data-product-id="123"><input type="radio" ' +
      'data-variant-id="456"></variant-picker>';
    expect(() =>
      swansonAdapter.pageIdentity?.(page(html.replace("</main>", picker + "</main>"))),
    ).toThrowError(expect.objectContaining({ code: "SWANSON.IDENTITY_UNVERIFIED" }));
  });
});
