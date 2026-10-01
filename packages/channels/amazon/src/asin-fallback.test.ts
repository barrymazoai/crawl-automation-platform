import { describe, expect, it } from "vitest";
import { amazonAdapter } from "./adapter.js";
import { amazonDocument, pageAsin, productRoot } from "./dom.js";

const asin = "B002CQU532";
const other = "B079LWRRNM";
const title = '<span id="productTitle">Example supplement</span>';
const feature = (id: string, value: string) =>
  `<div id="${id}" data-csa-c-asin="${value}">${id === "title_feature_div" ? title : ""}</div>`;
const offers = (value: string) =>
  '<div id="all-offers-display"><form>' +
  `<input type="hidden" id="all-offers-display-params" data-asin="${value}">` +
  "</form></div>";
const ownMetadata =
  '<div id="centerCol">' +
  feature("title_feature_div", asin) +
  feature("twister_feature_div", asin) +
  `<div id="olp_feature_div">${offers(asin)}</div></div>` +
  `<div id="rightCol"><div id="olpLinkWidget_feature_div">${offers(asin)}</div></div>`;
const page = (content: string) => ({
  html: `<html><body><div id="ppd">${content}</div></body></html>`,
  url: `https://www.amazon.com/dp/${asin}`,
  capturedAt: "2026-10-01T00:00:00.000Z",
});
const identify = (content: string) => pageAsin(productRoot(amazonDocument(page(content).html)));
const expectCode = (content: string, code: string) =>
  expect(() => identify(content)).toThrow(expect.objectContaining({ code }));

describe("product-owned ASIN fallback", () => {
  it("parses agreeing title, twister and offer metadata without hidden ASIN inputs", () => {
    const saved = page(
      ownMetadata +
        '<a id="bylineInfo">Visit the Example Store</a>' +
        '<img id="landingImage" src="https://m.media-amazon.com/images/I/example.jpg">',
    );
    expect(amazonAdapter.pageIdentity?.(saved)).toEqual({ listingId: asin, variantId: null });
    const parsed = amazonAdapter.parseProduct(saved);
    expect(parsed.evidence).toMatchObject({
      listingId: asin,
      title: "Example supplement",
      brandRaw: "Example",
    });
    expect(parsed.evidence.imageCandidates).toHaveLength(1);
    expect(parsed.commerce?.sku).toBe(asin);
    expect(parsed.facts.complete).toBe(false);
  });

  it.each([
    `<div id="centerCol">${feature("title_feature_div", asin)}</div>`,
    `<div id="centerCol">${feature("twister_feature_div", asin)}</div>`,
    `<div id="centerCol"><div id="olp_feature_div">${offers(asin)}</div></div>`,
    `<div id="rightCol"><div id="olpLinkWidget_feature_div">${offers(asin)}</div></div>`,
  ])("accepts each verified product-owned location: %s", (content) => {
    expect(identify(content)).toBe(asin);
  });

  it.each(["title_feature_div", "twister_feature_div"])("rejects disagreement in %s", (id) => {
    expectCode(ownMetadata.replace(feature(id, asin), feature(id, other)), "AMAZON.ASIN_CONFLICT");
  });

  it("rejects a conflicting offer control instead of taking the first identity", () => {
    expectCode(ownMetadata.replace(offers(asin), offers(other)), "AMAZON.ASIN_CONFLICT");
  });

  it.each(["", "invalid", "b002cqu532"])("refuses malformed metadata %j", (value) => {
    expectCode(
      ownMetadata.replace(
        feature("twister_feature_div", asin),
        feature("twister_feature_div", value),
      ),
      "AMAZON.PRODUCT_UNVERIFIED",
    );
  });

  it.each([
    '<div id="recommendations">',
    '<div id="sims-consolidated-1_feature_div">',
    '<div data-component-type="sp-sponsored-result">',
  ])("ignores recommendation-owned metadata, including copied widget IDs: %s", (wrapper) => {
    const recommendations = `${wrapper}${ownMetadata}<div data-asin="${other}"></div></div>`;
    expectCode(title + recommendations, "AMAZON.PRODUCT_UNVERIFIED");
    expect(identify(ownMetadata + recommendations.replaceAll(asin, other))).toBe(asin);
  });

  it("ignores unscoped ASINs, variation options, parent/media keys and canonical URLs", () => {
    const content =
      title +
      `<link rel="canonical" href="https://www.amazon.com/dp/${asin}">` +
      `<div data-asin="${asin}"></div><div id="centerCol"><div id="twister_feature_div">` +
      `<li data-asin="${other}"></li><script>var data = {parentAsin: "${asin}",` +
      `currentAsin: "${asin}", selectedAsin: "${asin}", mediaAsin: "${asin}"};</script>` +
      "</div></div>";
    expectCode(content, "AMAZON.PRODUCT_UNVERIFIED");
  });

  it("ignores metadata outside the product root", () => {
    const saved = page(title);
    saved.html = saved.html.replace("</body>", `${ownMetadata}</body>`);
    expect(() => amazonAdapter.pageIdentity?.(saved)).toThrow(
      expect.objectContaining({ code: "AMAZON.PRODUCT_UNVERIFIED" }),
    );
  });

  it("reports the observed ASIN even when the request names a different product", () => {
    const saved = { ...page(ownMetadata), url: `https://www.amazon.com/dp/${other}` };
    expect(amazonAdapter.pageIdentity?.(saved)).toEqual({ listingId: asin, variantId: null });
    expect(amazonAdapter.parseProduct(saved).identity.listingId).toBe(asin);
  });
});

describe("unchanged hidden-input identity", () => {
  it.each([`id="ASIN"`, `name="ASIN"`])("keeps %s authoritative", (attribute) => {
    const input = `<input type="hidden" ${attribute} value="${asin}">`;
    expect(identify(input)).toBe(asin);
    expect(identify(input + ownMetadata.replaceAll(asin, other))).toBe(asin);
  });

  it("accepts agreeing inputs and refuses conflicting inputs without falling back", () => {
    const input = `<input type="hidden" id="ASIN" value="${asin}">`;
    expect(identify(input + `<input name="ASIN" value="${asin}">`)).toBe(asin);
    expectCode(
      input + `<input name="ASIN" value="${other}">` + ownMetadata,
      "AMAZON.ASIN_CONFLICT",
    );
  });

  it.each(["", "bad"])("does not rescue an invalid hidden input %j", (value) => {
    expectCode(`<input id="ASIN" value="${value}">` + ownMetadata, "AMAZON.PRODUCT_UNVERIFIED");
  });
});
