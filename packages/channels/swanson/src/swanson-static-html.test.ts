import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { pageText } from "@crawl-automation/channels-core";
// Only this parity test reads the old parser; production uses the Swanson-owned reader.
import { parseSwansonStaticHtml as oldReader } from "@crawl-automation/v3-channels";
import { describe, expect, it } from "vitest";
import { SWANSON_ORIGIN } from "./swanson-address.js";
import { parseSwansonStaticHtml } from "./swanson-static-html.js";

const capturedAt = "2026-09-28T23:45:00.000Z";
const fixtures = [
  {
    file: "healthy-origins-d-ribose.html.gz",
    path: "/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr",
  },
  {
    file: "healthy-origins-ubiquinol-variant.html.gz",
    path: "/p/healthy-origins-ubiquinol-kaneka-qh-100-mg-60-sgels?variant=46318812168330",
  },
];

describe("the Swanson-owned static reader matches the previous adapter's reader", () => {
  it.each(fixtures)("preserves the entire projection of $file", ({ file, path }) => {
    const html = gunzipSync(readFileSync(new URL(`./fixtures/${file}`, import.meta.url))).toString(
      "utf8",
    );
    const url = `${SWANSON_ORIGIN}${path}`;
    // The adapter already supplied pageText before this move; compare with that exact old call.
    const previous = oldReader(html, url, capturedAt, (element) => pageText(element.innerHTML));

    expect(parseSwansonStaticHtml(html, url, capturedAt)).toStrictEqual(previous);
  });
});

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
