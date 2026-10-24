import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  hasIngredientsSection,
  pageText,
  readShopifyProduct,
} from "@crawl-automation/channels-core";
import { LabelCorePolicySchema } from "@crawl-automation/v3-contracts";
import { createDtcAdapter } from "./adapter.js";
import { dtcLabelCore, dtcLabelCoreV2, dtcLabelCoreV3, extractDtcLabelCore } from "./label-core.js";
import { dtcDocument } from "./product.js";

describe("DTC label core v3", () => {
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

  it("keeps the full Dherbs ingredient body linked from a nested accordion heading", () => {
    const html = `<div class="accordion accordion-flush">
      <div class="accordion-item"><h2 class="accordion-header"><a class="product-info-accordion collapsed"
        aria-controls="overview" data-bs-target="#overview"><span>Overview</span></a></h2></div>
      <div id="overview" class="accordion-collapse collapse"><p>General wellness description.</p></div>
      <div class="accordion-item"><h2 class="accordion-header"><a class="product-info-accordion collapsed"
        aria-controls="ingredients" data-bs-target="#ingredients"><span>Ingredients</span></a></h2></div>
      <div id="ingredients" class="accordion-collapse collapse"><div class="pt-8 pb-3">
        <p><span class="PRODUCT-INGREDIENT ACTIVE">CHAMOMILE FLOWER</span>,
        <span class="PRODUCT-INGREDIENT ACTIVE">GINGER ROOT</span></p>
      </div></div>
    </div>`;
    const result = extractDtcLabelCore(html);
    expect(result).toMatch(/Ingredients\n+CHAMOMILE FLOWER, GINGER ROOT/);
    expect(result).not.toContain("General wellness description");
    expect(dtcLabelCoreV2.extract(html)).not.toContain("CHAMOMILE FLOWER");
  });

  it("keeps an ingredient details body and a linked tab panel", () => {
    const details = `<details><summary>Other Ingredients:</summary><p>Rice flour, cellulose.</p></details>`;
    expect(extractDtcLabelCore(details)).toContain("Rice flour, cellulose.");
    const tab = `<div><div role="tablist"><button role="tab" aria-controls="ingredient-tab">Plant-based Ingredients</button></div>
      <div id="ingredient-tab" role="tabpanel" class="accordion-panel"><p>Chamomile flower, ginger root.</p></div></div>`;
    expect(extractDtcLabelCore(tab)).toContain("Chamomile flower, ginger root.");
    expect(dtcLabelCoreV2.extract(tab)).not.toContain("Chamomile flower, ginger root.");
  });

  it("keeps the rest of a page when a newly preserved details panel has ingredients", () => {
    const html = `<h1>Red Clover Blossom 375mg</h1><div class="product__accordion accordion">
      <details><summary aria-controls="ingredients"><div><h2>Ingredients</h2></div></summary>
        <div id="ingredients" class="accordion__content"><p>Red Clover blossom, vegetable cellulose.</p></div>
      </details></div>`;
    const result = extractDtcLabelCore(html);
    expect(result).toContain("Red Clover Blossom 375mg");
    expect(result).toContain("Red Clover blossom, vegetable cellulose.");
  });

  it("does not change an empty ingredient details panel", () => {
    const html = `<h1>Vitamin Capsules</h1><div class="accordion"><details>
      <summary><h2>Ingredients</h2></summary><div class="accordion__content">  </div>
    </details></div>`;
    expect(extractDtcLabelCore(html)).toBe(dtcLabelCoreV2.extract(html));
  });

  it("does not keep an FAQ answer that merely mentions ingredients", () => {
    const html = `<section class="faq"><h2>Frequently Asked Questions</h2>
      <div class="accordion-item"><h3><button aria-controls="answer">What are the ingredients?</button></h3></div>
      <div id="answer" class="accordion-collapse"><p>The answer is on the package.</p></div>
    </section>`;
    expect(extractDtcLabelCore(html)).not.toContain("The answer is on the package.");
  });

  it("preserves line structure when the label text has no page chrome", () => {
    const html = `<section><h2>Protein Bar Reimagined™</h2><p>The stack, in every 60 g bar</p>
      <div><span>20 g protein (40% DV)</span><span>4 g creatine monohydrate</span></div>
      <p>Ingredients: almonds, cocoa.</p></section>`;
    expect(extractDtcLabelCore(html)).toBe(pageText(html, { rowCells: true }));
  });

  it("keeps historical readers while the adapter selects v3", () => {
    expect(LabelCorePolicySchema.safeParse("dtc-label-core/1").success).toBe(true);
    expect(LabelCorePolicySchema.safeParse("dtc-label-core/2").success).toBe(true);
    expect(LabelCorePolicySchema.safeParse("dtc-label-core/3").success).toBe(true);
    expect(createDtcAdapter().planning?.corePolicy).toBe("dtc-label-core/3");
    const html = `<button>Add to cart</button><p>Ingredients: rice flour.</p>`;
    expect(dtcLabelCore.extract(html)).toBe(pageText(html, { rowCells: true }));
    expect(createDtcAdapter().planning?.labelCore).toBe(dtcLabelCoreV3);
    expect(createDtcAdapter().planning?.labelCore?.extract(html)).toBe("Ingredients: rice flour.");
  });
});

it.each([
  ["5247029e3337cbe9", "250kcal", "160mg"],
  ["fbe7438d1522a706", "375kcal", "200mg"],
  ["126a4ade76669973", "300kcal", "160mg"],
] as const)(
  "bounds retained Kate Farms %s to Nutrition Info and its ingredient declaration",
  (id, calories, sodium) => {
    const html = readFileSync(
      new URL(
        `../../../../tools/diag-corpus/round8/html/nosource-katefarms--dtc-${id}.html`,
        import.meta.url,
      ),
      "utf8",
    );
    const document = dtcDocument(html);
    const url = document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "";
    const product = readShopifyProduct(document, {
      url,
      siteKey: "shop.katefarms.com",
      imageOrigins: ["https://shop.katefarms.com", "https://cdn.shopify.com"],
    });
    expect(hasIngredientsSection(product.factsHtml ?? "")).toBe(true);
    const core = extractDtcLabelCore(product.factsHtml ?? "");
    expect(core.startsWith("Nutrition Info\nComposition\tAmount\n")).toBe(true);
    expect(core).toContain(`Calories\t${calories}`);
    expect(core).toContain(`Sodium\t${sodium}`);
    expect(core).toContain("Ingredients: Purified Water");
    expect(core).not.toContain("See More Nutrition Info");
    expect(core).not.toContain("Certifications");
    expect(core.length).toBeLessThan(2400);
  },
);
