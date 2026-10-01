import { expect, it } from "vitest";
import { hasLabelSection, labelSourcePolicy } from "./source-order.js";

it.each([
  ["amazon", "images-first"],
  ["wholefoods-amazon-formula", "images-first"],
  ["gnc", "text-first"],
  ["swanson", "text-first"],
  ["costco", "text-first"],
  ["dtc", "text-first"],
])("chooses the configured default for %s", (channel, order) => {
  expect(labelSourcePolicy(channel)).toEqual({ version: "label-sources/1", order });
});

it("accepts a channel override independently of any merge policy", () => {
  expect(labelSourcePolicy("amazon", "text-first").order).toBe("text-first");
});

it.each([
  ["<h2>Supplement Facts</h2><p>partial</p>", true],
  ["<h3>Nutrition Facts</h3>", true],
  ["<h2>Drug Facts</h2>", true],
  ["<p>Ingredients: water, salt</p>", true],
  ["<p>Inactive Ingredients: water</p>", true],
  ["<p>Our supplement supports your nutrition. Premium ingredients for life.</p>", false],
  ["<script>Ingredients: not visible</script><p>Great product</p>", false],
])("detects a label section without claiming completeness: %s", (html, expected) => {
  expect(hasLabelSection(html)).toBe(expected);
});
