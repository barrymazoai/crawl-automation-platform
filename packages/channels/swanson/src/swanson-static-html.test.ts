import { describe, expect, it } from "vitest";
import { SWANSON_ORIGIN } from "./swanson-address.js";
import { parseSwansonStaticHtml } from "./swanson-static-html.js";

const capturedAt = "2026-09-28T23:45:00.000Z";
const url = `${SWANSON_ORIGIN}/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr`;
const read = (html: string) => parseSwansonStaticHtml(html, url, capturedAt);

describe("static reader failures use registered errors", () => {
  it.each([
    "<title>Just a moment...</title>",
    "<title>Attention Required</title>",
    '<form id="challenge-form"></form>',
    "<div>cf-chl-bypass</div>",
  ])("refuses an access challenge: %s", (html) => {
    expect(() => read(html)).toThrowError(
      expect.objectContaining({
        code: "SWANSON.ACCESS_CHALLENGE",
      }),
    );
  });

  it.each(["<main></main>", "<main><h1>First</h1><h1>Second</h1></main>"])(
    "reports a missing or ambiguous product heading by code",
    (html) => {
      expect(() => read(html)).toThrowError(
        expect.objectContaining({
          code: "SWANSON.PRODUCT_TEMPLATE",
        }),
      );
    },
  );

  it("retains the cause when the page expression cannot read the template", () => {
    // One heading passes the heading check, but there is no main commerce region.
    expect(() => read("<h1>Product</h1>")).toThrowError(
      expect.objectContaining({
        code: "SWANSON.STATIC_PARSE_FAILED",
        cause: expect.objectContaining({ name: "TypeError" }),
      }),
    );
  });

  it("retains schema validation failures as the cause of the parse failure", () => {
    expect(() => read("<main><h1>Product</h1></main>")).toThrowError(
      expect.objectContaining({
        code: "SWANSON.STATIC_PARSE_FAILED",
        cause: expect.objectContaining({ name: "ZodError" }),
      }),
    );
  });

  it("refuses a URL outside Swanson before parsing", () => {
    expect(() =>
      parseSwansonStaticHtml("", "https://example.com/p/product", capturedAt),
    ).toThrowError(expect.objectContaining({ code: "CHANNEL.URL_REJECTED" }));
  });
});
