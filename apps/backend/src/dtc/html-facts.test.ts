import { describe, expect, it } from "vitest";
import { extractHtmlFacts } from "./html-facts.js";
import { hasCompleteFactsText } from "../gnc/facts.js";

const PAGE = "https://brand.example/products/shake";

describe("独立站页面成分表识别", () => {
  it("表格写法：抠成 GNC 同款 'HTML FACTS TABLE' 文本，能过完整性门", () => {
    const html = `<html><body><script>var captcha="Supplement Facts";</script>
      <div class="accordion"><h3>Supplement Facts</h3>
        <table><tr><td>Serving Size</td><td>1 Scoop (30 g)</td></tr><tr><td>Servings Per Container</td><td>30</td></tr>
        <tr><th>Amount Per Serving</th><th></th><th>% DV</th></tr>
        <tr><td>Vitamin D</td><td>25 mcg</td><td>125%</td></tr>
        <tr><td>Protein</td><td>20 g</td><td>40%</td></tr>
        <tr><td>Calcium</td><td>200 mg</td><td>15%</td></tr></table></div>
      <img alt="Chocolate shake front" src="/cdn/front.png"></body></html>`;
    const out = extractHtmlFacts(html, PAGE);
    expect(out.factsText).toMatch(/^HTML FACTS TABLE\n/);
    expect(out.factsText).toContain("Vitamin D | 25 mcg | 125%");
    expect(out.factsText).not.toContain("captcha");
    expect(hasCompleteFactsText(out.factsText!)).toBe(true);
    expect(out.factsImageUrls).toEqual([]);
  });

  it("非表格写法（div/li 排版）也能抠出来", () => {
    const html = `<html><body><section id="nutrition"><p>Nutrition Facts</p>
      <ul><li>Serving Size: 1 bottle (355 ml)</li><li>Servings Per Container: 1</li>
      <li>Calories 180</li><li>Protein 20 g 40%</li><li>Vitamin B12 2.4 mcg 100%</li><li>Iron 4 mg 22%</li></ul></section></body></html>`;
    const out = extractHtmlFacts(html, PAGE);
    expect(out.factsText).toContain("Serving Size: 1 bottle (355 ml)");
    expect(out.factsText).toContain("Vitamin B12 2.4 mcg 100%");
  });

  it("页面里没有成分表、但能指认成分表那张图 → 只返回图片提示", () => {
    const html = `<html><body><h1>Whey</h1>
      <img alt="front" src="https://cdn.example/front.jpg">
      <img alt="Supplement Facts panel" src="//cdn.example/label_back.jpg">
      <img alt="lifestyle" src="https://cdn.example/life.jpg">
      <a href="https://cdn.example/nutrition-label.png">See label</a></body></html>`;
    const out = extractHtmlFacts(html, PAGE);
    expect(out.factsText).toBeNull();
    expect(out.factsImageUrls).toEqual(["https://cdn.example/label_back.jpg", "https://cdn.example/nutrition-label.png"]);
  });

  it("什么都没有 → 两者皆空，交给全画廊 OCR", () => {
    const out = extractHtmlFacts(`<html><body><h1>Shake</h1><p>Delicious.</p><img alt="front" src="/a.png"></body></html>`, PAGE);
    expect(out).toEqual({ factsText: null, factsImageUrls: [] });
  });
});

describe("防误判：散文不能当成分表", () => {
  it("含 Serving Size 字样的营销文案 + 配料段 → 不算成分表", () => {
    const html = `<html><body><div id="productDescription">
      <p>The Nature Made Diabetes Health Pack is scientifically formulated to provide nutritional support for people with diabetes. Each packet includes a complete, full-potency formulation of vitamins, minerals, and alpha lipoic acid. Serving Size 1 packet.</p>
      <p>Label Information Ingredients Ascorbic Acid, Dibasic Calcium Phosphate, Cellulose Gel, Corn Starch, dl-alpha Tocopheryl Acetate, Lactose, Calcium Carbonate, Gelatin, Magnesium Oxide.</p>
      </div></body></html>`;
    expect(extractHtmlFacts(html, PAGE).factsText).toBeNull();
  });

  it("行数够但没有数量的清单 → 不算成分表", () => {
    const html = `<html><body><section><h3>Supplement Facts</h3><ul>
      <li>Serving Size: one capsule</li><li>Non-GMO</li><li>Gluten free</li><li>Third-party tested</li><li>Made in USA</li>
      </ul></section></body></html>`;
    expect(extractHtmlFacts(html, PAGE).factsText).toBeNull();
  });
});
