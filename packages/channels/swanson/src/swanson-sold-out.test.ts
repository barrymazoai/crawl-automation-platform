import { describe, expect, it } from "vitest";
import { swansonAdapter } from "./adapter.js";
import { parseSwansonStaticHtml, parseSwansonStaticIdentity } from "./swanson-static-html.js";

const url = "https://www.swansonvitamins.com/p/test-coq10";
const capturedAt = "2026-09-30T00:00:00.000Z";
const meta = { product: { id: 123, handle: "test-coq10", variants: [{ id: 456 }] } };
const script = `<script>var meta = ${JSON.stringify(meta)};</script>`;
const html = `<link rel="canonical" href="${url}">${script}
  <main><h1>Test CoQ10</h1><variant-picker data-product-id="123">
    <input type="radio" role="radio" name="Size" value="30 Softgels"
      data-connected-product-url="/p/other-coq10" data-variant-id="789"
      data-option-available="true" aria-checked="false">
    <input type="radio" role="radio" name="Size" value="60 Softgels" checked
      aria-checked="true" aria-label="Size: 60 Softgels - Unavailable"
      data-connected-product-url="/p/test-coq10" data-variant-id="456"
      data-option-available="false">
    <script type="application/json">{"id":456,"available":false}</script>
  </variant-picker><form class="cordial-bis-form"><button>Notify Me</button></form></main>`;
const read = (source: string) => parseSwansonStaticHtml(source, url, capturedAt);

describe("Swanson without an add-to-cart form", () => {
  it("reads the selected sold-out size, its product identity and stock status", () => {
    const parsed = swansonAdapter.parseProduct({ html, url, capturedAt });
    expect(parsed.identity).toEqual({ listingId: "123", variantId: "456" });
    expect(parsed.rendered?.selectedForms).toEqual([{ productId: "123", variantIds: ["456"] }]);
    expect(parsed.commerce?.availability).toBe("OutOfStock");
    expect(swansonAdapter.pageIdentity?.({ html, url, capturedAt })).toEqual({
      listingId: "test-coq10",
      variantId: "456",
    });
  });

  it("accepts an explicit aria selection and never runs the page's scripts", () => {
    const source = html.replace(" checked", "") + '<script>throw new Error("page code")</script>';
    const parsed = swansonAdapter.parseProduct({ html: source, url, capturedAt });
    expect(parsed.identity).toEqual({ listingId: "123", variantId: "456" });
  });

  it.each([
    ["no meta", html.replace(script, "")],
    ["no form or meta", `<link rel="canonical" href="${url}"><main><h1>Test</h1></main>`],
    ["no selected size", html.replace(" checked", "").replace('aria-checked="true"', "")],
    ["two selected sizes", html.replace('aria-checked="false"', 'aria-checked="true"')],
    ["contradictory selection", html.replace('aria-checked="true"', 'aria-checked="false"')],
    ["variant absent from meta", html.replace('data-variant-id="456"', 'data-variant-id="999"')],
    ["malformed meta", html.replace(script, "<script>var meta = {broken};</script>")],
  ])("uses a registry identity error for %s", (_name, source) => {
    const error = expect.objectContaining({ code: "SWANSON.IDENTITY_UNVERIFIED" });
    expect(() => read(source)).toThrowError(error);
    expect(() => parseSwansonStaticIdentity(source, url)).toThrowError(error);
  });

  it.each([
    ["product id", html.replace('data-product-id="123"', 'data-product-id="999"')],
    ["canonical handle", html.replace('"handle":"test-coq10"', '"handle":"another"')],
    ["selected option URL", html.replace('url="/p/test-coq10"', 'url="/p/another"')],
  ])("keeps %s strict", (_name, source) => {
    expect(() => read(source)).toThrowError(
      expect.objectContaining({ code: "SWANSON.IDENTITY_CONFLICT" }),
    );
  });

  it("keeps the requested variant strict", () => {
    expect(() =>
      swansonAdapter.parseProduct({ html, url: `${url}?variant=999`, capturedAt }),
    ).toThrowError(expect.objectContaining({ code: "SWANSON.VARIANT_CONFLICT" }));
  });

  it("retains normal form identity even when the fallback metadata is absent", () => {
    const form =
      '<product-form-component data-product-id="123">' +
      '<input name="id" value="456"></product-form-component>';
    expect(read(html.replace(script, form)).selectedForms).toEqual([
      { productId: "123", variantIds: ["456"] },
    ]);
  });
});
