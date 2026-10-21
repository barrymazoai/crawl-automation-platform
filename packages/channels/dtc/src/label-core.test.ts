import { describe, expect, it } from "vitest";
import { pageText } from "@crawl-automation/channels-core";
import { LabelCorePolicySchema } from "@crawl-automation/v3-contracts";
import { createDtcAdapter } from "./adapter.js";
import { dtcLabelCore, extractDtcLabelCore } from "./label-core.js";

describe("DTC label core v2", () => {
  it("removes Shopify chrome while keeping the entire Facts block", () => {
    const html = `
      <nav aria-label="Breadcrumb"><a>Home</a><a>Supplements</a></nav>
      <a class="visually-hidden" href="#product">Skip to product information</a>
      <main id="product">
        <div class="product__media"><button>Open media 1 in modal</button><span>1 / of 1</span></div>
        <div class="rating"><span>38 Reviews</span><p>Highly rated by customers for:</p></div>
        <h1>Magnesium Capsules</h1>
        <form action="/cart/add"><button>Add to cart</button><span>Quantity</span></form>
        <section class="faq"><h2>Frequently Asked Questions</h2>
          <details><summary>How does it work?</summary><p>For general wellness.</p></details>
        </section>
        <details class="accordion"><summary>Supplement Facts</summary>
          <div>Serving Size 2 Capsules</div><div>Calories</div>
          <div><span>Magnesium 100 mg</span><span>24%</span></div>
          <p>* Percent Daily Values are based on a 2,000 calorie diet.</p>
        </details>
        <p>Other Ingredients: vegetable cellulose.</p>
        <div class="share"><button>Share on Facebook</button></div>
      </main>`;
    const result = extractDtcLabelCore(html);
    expect(result).toContain("Supplement Facts\nServing Size 2 Capsules\nCalories");
    expect(result).toContain("Magnesium 100 mg\t24%");
    expect(result).toContain("* Percent Daily Values are based on a 2,000 calorie diet.");
    expect(result).toContain("Other Ingredients: vegetable cellulose.");
    for (const chrome of [
      "Home",
      "Skip to",
      "Open media",
      "1 / of 1",
      "38 Reviews",
      "Highly rated",
      "Add to cart",
      "Frequently Asked Questions",
      "For general wellness",
      "Share on Facebook",
    ]) {
      expect(result).not.toContain(chrome);
    }
  });

  it("keeps an ingredient paragraph inside a FAQ accordion when the page has no bounded Facts panel", () => {
    const html = `<section class="faq"><h2>Frequently Asked Questions</h2>
      <details><summary>How does it work?</summary><p>For general wellness.</p></details>
      <details><summary>What is in it?</summary><p><strong>Ingredients</strong>: rice flour.</p></details>
      <details><summary>How much?</summary><p>Take 2 VegCaps daily.</p></details>
    </section>`;
    expect(extractDtcLabelCore(html)).toBe("Ingredients: rice flour.\n\nTake 2 VegCaps daily.");
  });

  it("preserves line structure when the label text has no page chrome", () => {
    const html = `<section><h2>Protein Bar Reimagined™</h2><p>The stack, in every 60 g bar</p>
      <div><span>20 g protein (40% DV)</span><span>4 g creatine monohydrate</span></div>
      <p>Ingredients: almonds, cocoa.</p></section>`;
    expect(extractDtcLabelCore(html)).toBe(pageText(html, { rowCells: true }));
  });

  it("accepts both DTC core policy versions while the adapter selects v2", () => {
    expect(LabelCorePolicySchema.safeParse("dtc-label-core/1").success).toBe(true);
    expect(LabelCorePolicySchema.safeParse("dtc-label-core/2").success).toBe(true);
    expect(createDtcAdapter().planning?.corePolicy).toBe("dtc-label-core/2");
    const html = `<button>Add to cart</button><p>Ingredients: rice flour.</p>`;
    expect(dtcLabelCore.extract(html)).toBe(pageText(html, { rowCells: true }));
    expect(createDtcAdapter().planning?.labelCore?.extract(html)).toBe("Ingredients: rice flour.");
  });
});
