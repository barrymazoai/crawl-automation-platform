import { expect, it } from "vitest";
import { hasLabelSection, labelSourcePolicy } from "./source-order.js";

it.each([
  ["amazon", "images-first"],
  ["wholefoods-amazon-formula", "images-first"],
  ["gnc", "text-first"],
  ["swanson", "text-first"],
  ["costco", "text-first"],
  ["dtc", "images-first"],
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
  // GNC's facts table (2026-10-01, product 593764) has no "Facts" heading.
  ["<h3>Ingredients</h3><p>View Nutrition Label</p><p>Serving Size: 3 Capsules</p>", true],
  ["<p>Serving Size 3</p><p>Other Ingredients</p><p>Rice Flour, Silica</p>", true],
  ["<p>Amount Per Serving</p><p>Vitamin C 500 mg</p>", true],
  ["<p>Our supplement supports your nutrition. Premium ingredients for life.</p>", false],
  ["<p>Pick the serving size that suits you.</p>", false],
  ["<script>Ingredients: not visible</script><p>Great product</p>", false],
  // Owner 2026-10-08: PureTrim's ingredient list sits under a descriptive heading.
  ["<h3>Plant-Based Ingredients</h3><p>Organic Beet Root Powder, Ribose</p>", true],
  ["<p>Key Ingredients:</p><p>Ashwagandha</p>", true],
  ["<p>Made with clean ingredients</p>", false],
])("detects a label section without claiming completeness: %s", (html, expected) => {
  expect(hasLabelSection(html)).toBe(expected);
});
