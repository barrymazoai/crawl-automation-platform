import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { gncAdapter } from "./gnc-adapter.js";
import { gncProductFamily, readGncOptions } from "./gnc-options.js";

const html = gunzipSync(
  readFileSync(new URL("./fixtures/product-877080.html.gz", import.meta.url)),
).toString("utf8");
const parsed = gncAdapter.parseProduct({
  url: "https://www.gnc.com/vitamin-d/877080.html",
  html,
  capturedAt: "2026-09-28T12:00:00.000Z",
});

const picker = (options: string) => `<div data-attribute-id="size"><ul>${options}</ul></div>`;
const sizes = picker(
  '<li><a href="/vitamin-d/877080.html" title="30 Servings">30</a></li>' +
    '<li><a href="/vitamin-d/877081.html" title="60 Servings">60</a></li>',
);

describe("GNC family from the option picker", () => {
  it("claims no family on the real 877080 page, which has no picker", () => {
    expect(gncAdapter.productFamily?.(parsed)).toBeNull();
  });

  it("reads a size picker: the current SKU selected, the others as members with their labels", () => {
    const family = gncProductFamily({
      ...parsed,
      rendered: { ...parsed.rendered, options: readGncOptions(sizes) },
    });
    expect(family).toEqual({
      differsBy: "size",
      group: "size",
      selectedLabel: "30 Servings",
      members: [
        {
          listingId: "877081",
          variantId: null,
          url: "https://www.gnc.com/vitamin-d/877081.html",
          label: "60 Servings",
        },
      ],
    });
  });

  it.each([
    [
      "an option without a SKU page",
      picker(
        '<li><a href="/vitamin-d/877080.html" title="30">30</a></li><li><a href="/sale/">Sale</a></li>',
      ),
    ],
    ["two option groups", sizes + sizes],
    [
      "a picker that does not include the current SKU",
      picker(
        '<li><a href="/x/111111.html" title="A">A</a></li><li><a href="/x/222222.html" title="B">B</a></li>',
      ),
    ],
  ])("claims no family for %s", (_case, page) => {
    const rendered = { ...parsed.rendered, options: readGncOptions(page) };
    expect(gncProductFamily({ ...parsed, rendered })).toBeNull();
  });
});
