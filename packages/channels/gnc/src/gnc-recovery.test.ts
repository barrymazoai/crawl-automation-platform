import * as platform from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import { gncCommerce } from "./gnc-commerce.js";
import { gncFamilyMembers } from "./gnc-family.js";

it("records malformed JSON-LD while preserving independent meta tags and family links", () => {
  const record = vi.spyOn(platform, "recordRecovery").mockImplementation(() => undefined);
  const html = `<script type="application/ld+json">{broken</script>
    <meta property="product:price:amount" content="12.00">
    <div class="product-variations"><a href="/product/123456.html">Size</a></div>`;
  expect(gncCommerce(html, "123456").price).toBe("12.00");
  const page = {
    capturedAt: "2026-09-30T00:00:00.000Z",
    html,
    url: "https://www.gnc.com/family.html",
    status: 200,
  };
  expect(gncFamilyMembers(page).map((item) => item.listingId)).toEqual(["123456"]);
  expect(record).toHaveBeenCalledTimes(2);
  for (const call of record.mock.calls) {
    expect(call[0]).toBeInstanceOf(SyntaxError);
  }
  record.mockRestore();
});
