import { describe, expect, it } from "vitest";
import { amazonDocument, pageAsin, productRoot } from "./dom.js";

const asin = "B002CQU532";
const documentOf = (body: string) =>
  amazonDocument(`<html><head><title>Amazon.com</title></head><body>${body}</body></html>`);
const rootOf = (content: string) => productRoot(documentOf(`<div id="ppd">${content}</div>`));

describe("product root diagnostics", () => {
  it.each([
    { count: 0, check: "ppd-missing" },
    { count: 2, check: "ppd-not-unique" },
    { count: 3, check: "ppd-not-unique" },
  ])("reports $check for $count roots", ({ count, check }) => {
    const document = documentOf('<div id="ppd"></div>'.repeat(count));
    expect(() => productRoot(document)).toThrow(
      expect.objectContaining({
        code: "AMAZON.PRODUCT_UNVERIFIED",
        details: { check, ppdCount: count, pageTitleLength: 10 },
      }),
    );
  });

  it("keeps accepting one product root", () => {
    const document = documentOf('<div id="ppd"></div>');
    expect(productRoot(document)).toBe(document.querySelector("#ppd"));
  });
});

describe("ASIN diagnostics", () => {
  it("reports unavailable ASINs without inferring identity from recommendations", () => {
    const root = rootOf(`<div id="recommendations"><div data-asin="${asin}"></div></div>`);
    expect(() => pageAsin(root)).toThrow(
      expect.objectContaining({
        code: "AMAZON.PRODUCT_UNVERIFIED",
        details: {
          check: "asin-unavailable",
          asinSource: "metadata",
          asinCount: 0,
          invalidAsinCount: 0,
          pageTitleLength: 10,
        },
      }),
    );
  });

  it.each(["", "invalid", "b002cqu532", `&lt;private&gt;${"x".repeat(10_000)}`])(
    "reports invalid inputs without copying their values: case %#",
    (value) => {
      const root = rootOf(`<input id="ASIN" value="${value}"><input name="ASIN" value="${asin}">`);
      expect(() => pageAsin(root)).toThrow(
        expect.objectContaining({
          code: "AMAZON.PRODUCT_UNVERIFIED",
          details: {
            check: "asin-invalid",
            asinSource: "input",
            asinCount: 2,
            invalidAsinCount: 1,
            pageTitleLength: 10,
          },
        }),
      );
    },
  );

  it("keeps invalid hidden inputs authoritative over valid fallback metadata", () => {
    const root = rootOf(
      '<input id="ASIN"><div id="centerCol">' +
        `<div id="title_feature_div" data-csa-c-asin="${asin}"></div></div>`,
    );
    expect(() => pageAsin(root)).toThrow(
      expect.objectContaining({
        code: "AMAZON.PRODUCT_UNVERIFIED",
        details: {
          check: "asin-invalid",
          asinSource: "input",
          asinCount: 1,
          invalidAsinCount: 1,
          pageTitleLength: 10,
        },
      }),
    );
  });

  it("counts invalid fallback values separately from valid ones", () => {
    const root = rootOf(
      '<div id="centerCol"><div id="title_feature_div" data-csa-c-asin="bad"></div>' +
        '<div id="twister_feature_div" data-csa-c-asin=""></div>' +
        '<div id="olp_feature_div"><div id="all-offers-display"><form>' +
        `<input id="all-offers-display-params" data-asin="${asin}"></form></div></div></div>`,
    );
    expect(() => pageAsin(root)).toThrow(
      expect.objectContaining({
        code: "AMAZON.PRODUCT_UNVERIFIED",
        details: {
          check: "asin-invalid",
          asinSource: "metadata",
          asinCount: 3,
          invalidAsinCount: 2,
          pageTitleLength: 10,
        },
      }),
    );
  });

  it("keeps agreeing ASINs valid and conflicting ASINs on their existing error code", () => {
    const input = `<input id="ASIN" value="${asin}">`;
    expect(pageAsin(rootOf(input + `<input name="ASIN" value="${asin}">`))).toBe(asin);
    expect(() => pageAsin(rootOf(input + '<input name="ASIN" value="B079LWRRNM">'))).toThrow(
      expect.objectContaining({ code: "AMAZON.ASIN_CONFLICT" }),
    );
  });
});
