import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { swansonAdapter } from "./adapter.js";
import { swansonIdentityMapping } from "./identity-map.js";

const url =
  "https://www.swansonvitamins.com/p/healthy-origins-ubiquinol-kaneka-qh-100-mg-60-sgels?variant=46318812168330";
const html = gunzipSync(
  readFileSync(new URL("./fixtures/healthy-origins-ubiquinol-variant.html.gz", import.meta.url)),
).toString();

describe("saved Swanson handle and numeric identity", () => {
  it("binds only this page's handle to its numeric product and exact variant", () => {
    const parsed = swansonAdapter.parseProduct({ url, html, capturedAt: "2026-09-29T00:00:00Z" });
    expect(swansonIdentityMapping(parsed.rendered)).toEqual({
      handle: "healthy-origins-ubiquinol-kaneka-qh-100-mg-60-sgels",
      productId: "8572274245770",
      variantId: "46318812168330",
    });
    expect(parsed.identity).toEqual({ listingId: "8572274245770", variantId: "46318812168330" });
    const family = swansonAdapter.productFamily?.(parsed);
    expect(family?.members).toEqual([
      {
        listingId: "healthy-origins-ubiquinol-kaneka-qh-100-mg-150-sgels",
        variantId: "46318811119754",
        label: "150 Softgels",
        url: "https://www.swansonvitamins.com/p/healthy-origins-ubiquinol-kaneka-qh-100-mg-150-sgels?variant=46318811119754",
      },
    ]);
    expect(family?.differsBy).toBe("size");
  });

  it("does not fabricate an ID from a handle or an ambiguous selected form", () => {
    expect(() => swansonIdentityMapping({ canonicalUrl: url, selectedForms: [] })).toThrow();
    expect(() =>
      swansonIdentityMapping({
        canonicalUrl: url,
        selectedForms: [{ productId: "handle", variantIds: ["123"] }],
      }),
    ).toThrow();
  });
});
