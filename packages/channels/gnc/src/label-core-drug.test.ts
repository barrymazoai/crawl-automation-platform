import { describe, expect, it } from "vitest";
import { extractGncLabelCore } from "./label-core.js";

const label = (body: string) => `<div class="product-nutrition-description">${body}</div>`;
const accordion = (heading: string) =>
  '<div class="pdp-details-accordion__section">' +
  `<h4>${heading}</h4><div class="pdp-details-accordion__section-content">Flaxseed</div></div>`;
const foodTable =
  "<table><tr><td>Nutrition Facts</td><td>Serving Size 15 g</td></tr>" +
  "<tr><th>Amount Per Serving</th></tr><tr><td>Protein 3 g</td></tr></table>";
const drugTable =
  "<h4>Drug Facts</h4><table><tr><th>Active ingredient</th><th>Purpose</th></tr>" +
  "<tr><td>Arnica montana 30C HPUS</td><td>Relieves pain</td></tr></table>";

describe("GNC shared Drug Facts and ingredient scoping", () => {
  it("scopes a Drug Facts panel across its table and inactive ingredient accordion", () => {
    const core = extractGncLabelCore(label(drugTable + accordion("Inactive Ingredients")));
    expect(core).toMatch(/^Drug Facts/);
    expect(core).toContain("30C HPUS");
    expect(core).toContain("Relieves pain");
    expect(core).toMatch(/Inactive Ingredients\s+Flaxseed$/);
    expect(core).not.toContain("Serving Size");
  });

  it.each(["Ingredients", "Ingredients:"])("accepts a food's %s accordion", (heading) => {
    expect(extractGncLabelCore(label(foodTable + accordion(heading)))).toContain(heading);
  });

  it("prefers Other Ingredients without counting the generic heading", () => {
    const core = extractGncLabelCore(
      label(foodTable + accordion("Ingredients") + accordion("Other Ingredients")),
    );
    expect(core).toMatch(/Other Ingredients\s+Flaxseed$/);
  });

  it.each(["Ingredients", "Other Ingredients", "Inactive Ingredients"])(
    "refuses duplicate %s",
    (heading) => {
      const facts = heading.startsWith("Inactive") ? drugTable : foodTable;
      expect(() => extractGncLabelCore(label(facts + accordion(heading).repeat(2)))).toThrow();
    },
  );

  it("refuses a second Drug Facts panel even inside one product label", () => {
    expect(() =>
      extractGncLabelCore(label(drugTable.repeat(2) + accordion("Inactive Ingredients"))),
    ).toThrow(expect.objectContaining({ code: "LABEL_CORE.LABEL_SCOPE_AMBIGUOUS" }));
  });
});
