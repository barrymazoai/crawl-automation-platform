import { describe, expect, it } from "vitest";
import { pageText } from "./page-text.js";

// The three cases of the hand-written reader this replaces (v3-channels static-inner-text).
describe("pageText", () => {
  it("puts table rows on their own lines and separates cells with a tab", () => {
    const html =
      "<table><tr><th>Amount Per Serving</th><th>% Daily Value</th></tr><tr><td>D-Ribose 5 g</td><td>†</td></tr></table>";
    expect(pageText(html)).toBe("Amount Per Serving\t% Daily Value\nD-Ribose 5 g\t†");
  });

  it("separates paragraphs by one blank line and collapses whitespace", () => {
    const html =
      "<p>Serving   Size\n 1 Scoop</p><p>Other Ingredients: None<br></p><p>Suggested Use: daily</p>";
    expect(pageText(html)).toBe(
      "Serving Size 1 Scoop\n\nOther Ingredients: None\n\nSuggested Use: daily",
    );
  });

  it("leaves out hidden elements and scripts", () => {
    const html =
      '<span>shown</span><span hidden>hidden</span><span aria-hidden="true">aria</span><script>x()</script>';
    expect(pageText(html)).toBe("shown");
  });

  it("keeps a line break that is followed by more text", () => {
    expect(pageText("<div>Serving Size<br>1 Scoop</div>")).toBe("Serving Size\n1 Scoop");
  });

  // The hand-written reader counted whitespace between two blocks as text and drew an extra blank line; a browser
  // does not (checked against the Ego captures of real Swanson pages in v3-channels/src/fixtures).
  it("draws no blank line for whitespace between blocks, as a browser shows it", () => {
    const facts =
      "<details><summary>Product Facts</summary>\n <div>  <h2>Supplement Facts</h2></div></details>";
    expect(pageText(facts)).toBe("Product Facts\nSupplement Facts");
    const table =
      "<table><thead> <tr><th>Amount Per Serving</th><th>% Daily Value</th></tr> </thead> <tbody> <tr><td>Calories 20</td><td></td></tr></tbody></table>";
    expect(pageText(table)).toBe("Amount Per Serving\t% Daily Value\nCalories 20");
  });
});
