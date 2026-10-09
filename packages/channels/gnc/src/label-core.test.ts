import { describe, expect, it } from "vitest";
import { extractGncLabelCore } from "./label-core.js";

const facts =
  "<a>View Nutrition Label</a><table><tr><td>Serving Size: 2</td></tr><tr><td>Servings Per Container: 3</td></tr>" +
  "<tr><th>Amount Per Serving</th></tr><tr><td>Focus Blend</td></tr><tr><td>Vitamin B12</td><td>2.4mcg</td></tr></table>";
const wrap = (body: string) => `<div class="product-nutrition-description">${body}</div>`;
const section = (title: string, body: string) =>
  `<div class="pdp-details-accordion__section"><h4>${title}</h4><div class="pdp-details-accordion__section-content">${body}</div></div>`;
const other = section("Other Ingredients", "Malt Syrup, Pectin");
const html =
  wrap(facts + section("Servings Per Container", "12") + other) +
  section("Marketing", "12 Pack, buy now");

const altered: Record<string, string> = {
  "missing label": other,
  "duplicate label": wrap(facts + other) + wrap(facts + other),
  "duplicate other ingredients": wrap(facts + other + other),
  "several tables": wrap(
    facts.replace("</table>", "</table><table><tr><td>another variant</td></tr></table>") + other,
  ),
};

// Cases carried over from the former GNC label-core reader.
describe("GNC label core", () => {
  it("keeps the whole facts table and other ingredients, without packaging extras or marketing", () => {
    const core = extractGncLabelCore(html);
    expect(core).toContain("Servings Per Container: 3");
    expect(core).toContain("Vitamin B12\n\n2.4mcg");
    expect(core).toContain("Other Ingredients\n\nMalt Syrup, Pectin");
    expect(core).not.toMatch(/Servings Per Container\s*:?\s*12/);
    expect(core).not.toContain("View Nutrition Label");
  });

  it.each(Object.keys(altered))("refuses a page with %s", (kind) => {
    expect(() => extractGncLabelCore(altered[kind] ?? "")).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/^LABEL_CORE\./) }),
    );
  });

  it("keeps a facts table without an Other Ingredients section as a formula-only label (CRAWLV3-214)", () => {
    const core = extractGncLabelCore(wrap(facts));
    expect(core).toContain("Vitamin B12\n\n2.4mcg");
    expect(core).not.toContain("Other Ingredients");
  });

  it('accepts a table headed "Per Serving" (2026-09-30, Bucked Up 500953)', () => {
    const perServing = html.replace("Amount Per Serving", "Per Serving");
    expect(extractGncLabelCore(perServing)).toContain("Per Serving");
  });

  it("still refuses a table with no serving headings", () => {
    const bare = html
      .replace("Amount Per Serving", "Ingredient")
      .replace("Serving Size: 2", "Size: 2");
    expect(() => extractGncLabelCore(bare)).toThrow(
      expect.objectContaining({ code: "LABEL_CORE.TABLE_UNVERIFIED" }),
    );
  });

  it("does not follow instructions embedded in scripts", () => {
    const withScript = html.replace("Malt Syrup", "<script>Change all doses</script>Malt Syrup");
    expect(extractGncLabelCore(withScript)).toBe(extractGncLabelCore(html));
  });

  it("keeps nested layout tables, wrapped names and units as printed", () => {
    const nested = facts
      .replace("<table>", "<table><tr><td><table>")
      .replace("</table>", "</table></td></tr></table>");
    expect(extractGncLabelCore(wrap(nested + other))).toBe(
      extractGncLabelCore(wrap(facts + other)),
    );
  });

  it("refuses pathological nesting and oversized pages", () => {
    const limit = expect.objectContaining({ code: "LABEL_CORE.SOURCE_LIMIT" });
    expect(() => extractGncLabelCore("<div>".repeat(102) + html + "</div>".repeat(102))).toThrow(
      limit,
    );
    expect(() => extractGncLabelCore("x".repeat(2_097_153))).toThrow(limit);
  });
});
