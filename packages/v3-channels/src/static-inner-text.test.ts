import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { staticInnerText } from "./static-inner-text.js";

const textOf = (html: string) => staticInnerText(parseHTML(`<!doctype html><html><body><div id="x">${html}</div></body></html>`).document.getElementById("x") as never);

describe("staticInnerText", () => {
  it("puts table rows on their own lines and separates cells with a tab", () => {
    expect(textOf("<table><tr><th>Amount Per Serving</th><th>% Daily Value</th></tr><tr><td>D-Ribose 5 g</td><td>†</td></tr></table>"))
      .toBe("Amount Per Serving\t% Daily Value\nD-Ribose 5 g\t†");
  });
  it("separates paragraphs by one blank line and collapses whitespace", () => {
    expect(textOf("<p>Serving   Size\n 1 Scoop</p><p>Other Ingredients: None<br></p><p>Suggested Use: daily</p>"))
      .toBe("Serving Size 1 Scoop\n\nOther Ingredients: None\n\nSuggested Use: daily");
  });
  it("leaves out hidden elements and scripts", () => {
    expect(textOf('<span>shown</span><span hidden>hidden</span><span aria-hidden="true">aria</span><script>x()</script>'))
      .toBe("shown");
  });
});
