import { expect, it } from "vitest";
import { gncFactsTableComplete } from "./gnc-facts.js";

const table = (rows: string) =>
  "<table><tr><th>Serving Size 6g (1 Rounded Teaspoon)</th></tr><tr><th>Amount Per Serving</th>" +
  `<th>% DV</th></tr><tr><td>Calories</td><td>5</td></tr>${rows}</table>`;
const other = "<p>Other Ingredients: Natural and Artificial Flavor, Citric Acid, Sucralose</p>";

it("requires a table, a serving size, an ingredient amount and other ingredients", () => {
  const creatine = "<tr><td>Creatine Monohydrate</td><td>5g</td><td>**</td></tr>";
  expect(gncFactsTableComplete(table(creatine) + other)).toEqual({
    complete: true,
    reasons: [],
    ingredientRows: 1,
  });
  expect(gncFactsTableComplete(table("") + other).reasons).toEqual(["GNC.FACTS_AMOUNTS_MISSING"]);
  const noOther = table("<tr><td>Creatine Monohydrate</td><td>5g</td></tr>");
  expect(gncFactsTableComplete(noOther).reasons).toEqual(["GNC.FACTS_OTHER_INGREDIENTS_MISSING"]);
  const image = '<img src="https://www.gnc.com/facts.png">' + other;
  expect(gncFactsTableComplete(image).reasons).toEqual(
    expect.arrayContaining(["GNC.FACTS_TABLE_MISSING", "GNC.FACTS_SERVING_SIZE_MISSING"]),
  );
  expect(gncFactsTableComplete(null)).toMatchObject({
    complete: false,
    reasons: ["GNC.FACTS_DOM_MISSING"],
  });
});
