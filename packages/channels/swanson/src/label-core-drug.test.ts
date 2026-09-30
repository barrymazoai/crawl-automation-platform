import { describe, expect, it } from "vitest";
import { extractSwansonLabelCore } from "./label-core.js";

const project = (text: string) => `<pre>${text}</pre>`;
// Handwritten minimal examples of the saved page's projected Drug/Nutrition Facts markup.
const drug =
  "Drug Facts\nActive ingredient (in each tablet)\nActive ingredient\tPurpose\n" +
  "Arnica montana 1X HPUS 7%\tRelieves muscle pain\nUses\nMuscle pain\nWarnings\nExternal use\n" +
  "Directions\nApply\nOther information\nStore cool\nInactive Ingredients\nalcohol, water\n" +
  "Country of Origin\nFrance";
const food =
  "Nutrition Facts\nServing Size 2 Tbsp\nAmount Per Serving\nProtein 3 g\n" +
  "Ingredients\nOrganic flaxseeds.\nSuggested Use: blend into smoothies";

describe("Swanson Drug Facts and food labels", () => {
  it("starts after Label 1 and ends after inactive ingredients, keeping Purpose and exclusions", () => {
    const core = extractSwansonLabelCore(project(`Label 1\n${drug}`));
    expect(core).toBe(drug.split("\nCountry of Origin")[0]?.replace(/\t/g, " "));
    expect(core).toContain("1X HPUS 7% Relieves muscle pain");
    expect(core).not.toContain("Label 1");
  });

  it.each([
    `${drug}\n${drug}`,
    drug.replace("Inactive Ingredients", "Other Ingredients"),
    drug.replace("Country of Origin", "Inactive Ingredients"),
    drug.replace("Active ingredient", "Content"),
  ])("refuses duplicated panels or an unverified active/inactive scope", (text) => {
    expect(() => extractSwansonLabelCore(project(text))).toThrow();
  });

  it.each(["Ingredients", "Ingredients:"])("accepts the food heading %s", (heading) => {
    expect(extractSwansonLabelCore(project(food.replace("Ingredients", heading)))).toMatch(
      /Organic flaxseeds\.$/,
    );
  });

  it("selects Other Ingredients when both spellings occur", () => {
    const text = food.replace("Ingredients\n", "Ingredients: flax\nOther Ingredients:\n");
    expect(extractSwansonLabelCore(project(text))).toContain("Other Ingredients:");
  });

  it.each(["Ingredients", "Other Ingredients"])("refuses two %s headings", (heading) => {
    const text = food.replace("Ingredients", `${heading}: flax\n${heading}`);
    expect(() => extractSwansonLabelCore(project(text))).toThrow();
  });

  it("still requires serving headings on Nutrition Facts", () => {
    expect(() => extractSwansonLabelCore(project(food.replace("Serving Size", "Portion")))).toThrow(
      expect.objectContaining({ code: "LABEL_CORE.TABLE_UNVERIFIED" }),
    );
  });
});
