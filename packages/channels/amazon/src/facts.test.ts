import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { amazonAdapter, amazonFacts } from "./index.js";
import { savedPage, savedPaths } from "./testing/saved-pages.js";

const fixture = savedPage(savedPaths.collagen);
const complete =
  "<h4>Supplement Facts</h4><p>Serving Size: 3 Caplets</p>" +
  "<table><tr><th>Amount per serving</th><th>% Daily Value</th></tr>" +
  "<tr><td>Vitamin C</td><td>60 mg</td><td>67%</td></tr></table>" +
  "<h4>Other Ingredients</h4><p>Cellulose, Silica, Vegetable Magnesium Stearate.</p>";

/**
 * Controlled mutations of a retained page exercise branches absent from the five unchanged
 * captures.
 */
function withFacts(html: string) {
  const page = fixture.read();
  const document = parseHTML(page.html).document;
  const section = document.getElementById("important-information");
  if (!section) {
    throw new Error("The saved page must contain important-information");
  }
  section.innerHTML = html;
  return amazonAdapter.parseProduct({ ...page, html: document.toString() });
}

describe.skipIf(!fixture.available)(`${fixture.name}: controlled facts mutations`, () => {
  it("accepts a complete facts label and independently recomputes it in planning", () => {
    const product = withFacts(complete);
    expect(product.facts).toMatchObject({ complete: true, missing: [] });
    expect(product.facts.text).toContain("Vitamin C\t60 mg\t67%");
    expect(product.facts.text).toContain("Other Ingredients");
    const planning = amazonAdapter.planning;
    expect(
      planning?.read(planning.projection(product.rendered), fixture.read().url, product.identity)
        .facts,
    ).toEqual(product.facts);
  });

  it.each([
    [complete.replace("Serving Size: 3 Caplets", ""), "FACTS.SERVING_SIZE_MISSING"],
    [complete.replace("Serving Size: 3 Caplets", "Serving Size:"), "FACTS.SERVING_SIZE_MISSING"],
    [complete.replace("60 mg", ""), "FACTS.AMOUNTS_MISSING"],
    [complete.replace("Other Ingredients", "Directions"), "FACTS.OTHER_INGREDIENTS_MISSING"],
    [complete.replace("Supplement Facts", "Ingredients"), "AMAZON.FACTS_LABEL_MISSING"],
    [
      complete.replace("Cellulose, Silica, Vegetable Magnesium Stearate.", "See packaging"),
      "AMAZON.FACTS_INCOMPLETE",
    ],
    [
      complete.replace("Cellulose, Silica, Vegetable Magnesium Stearate.", "Cellulose…"),
      "AMAZON.FACTS_INCOMPLETE",
    ],
  ])("keeps images when a required facts component is missing (%s)", (html, reason) => {
    const product = withFacts(html);
    expect(product.facts.complete).toBe(false);
    expect(product.facts.missing).toContain(reason);
    expect(product.evidence.imageCandidates).toHaveLength(7);
  });

  it("excludes serving weight, directions and marketing from active amounts", () => {
    const html =
      complete.replace("3 Caplets", "3 g").replace("60 mg", "") +
      "<h4>Directions</h4><p>Take 60 mg daily.</p>";
    expect(withFacts(html).facts.missing).toContain("FACTS.AMOUNTS_MISSING");
  });

  it("returns no facts when only safety information and directions remain", () => {
    const product = withFacts(
      "<h4>Safety Information</h4><p>See ingredients, labeling and warnings.</p>" +
        "<h4>Directions</h4><p>Serving Size 1 tablet, Vitamin C 60 mg. " +
        "Other Ingredients: cellulose.</p>",
    );
    expect(product.facts).toEqual({ text: null, complete: false, missing: ["FACTS.TEXT_MISSING"] });
    expect(product.evidence.factsCandidates).toEqual([]);
  });

  it("accepts complete facts split across two selected-product sections", () => {
    const page = fixture.read();
    const document = parseHTML(page.html).document;
    const important = document.getElementById("important-information");
    if (!important) {
      throw new Error("Missing information section");
    }
    important.innerHTML = "<h4>Other Ingredients</h4><p>Cellulose, Silica.</p>";
    const facts = document.createElement("section");
    facts.id = "supplementFacts";
    facts.innerHTML =
      "<h4>Supplement Facts</h4><p>Serving Size: 3 Caplets</p>" +
      "<table><tr><td>Vitamin C</td><td>60 mg</td></tr></table>";
    document.body.append(facts);
    expect(amazonAdapter.parseProduct({ ...page, html: document.toString() }).facts.complete).toBe(
      true,
    );
  });
});

describe("facts-only verdict", () => {
  it("rejects a missing block", () => {
    expect(amazonFacts(null)).toEqual({
      text: null,
      complete: false,
      missing: ["FACTS.TEXT_MISSING"],
    });
  });
});
