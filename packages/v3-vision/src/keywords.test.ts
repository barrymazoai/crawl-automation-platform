import { expect, it } from "vitest";
import { DefaultKeywordPolicy } from "@crawl-automation/v3-contracts";
import { screenKeywords, verifySelection } from "./keywords.js";
import { imageProductDecision } from "./product.js";
import { image, observation, selection } from "./testing.fixture.js";
it.each(["Supplement Facts", "SUPPLEMENT\nFacts", "Nutrition\tFacts", "INGREDIENTS:", "Other\n ingredients", "(Ingredients)"])("matches %s", text => {
  expect(selection(text).status).toBe("matched");
});
it.each(["", "Natural orange flavor", "Supplement Faets", "ingredient", "noningredients", "ingredients2"])("does not infer/repair/fallback: %s", text => {
  expect(selection(text).status).toBe("not_matched");
});
it("supports an explicit versioned keyword list", () => {
  const s = screenKeywords({ observation, image, ocrOperationId: "ocr", text: "ingredients" }, { ...DefaultKeywordPolicy, keywords: ["Nutrition Facts"] });
  expect(s.status).toBe("not_matched"); expect(s.policyFingerprint).not.toBe(selection().policyFingerprint);
});
it("rejects ownership mismatch", () => {
  expect(() => screenKeywords({ observation, image: { ...image, variantId: "other" }, ocrOperationId: "ocr", text: "ingredients" })).toThrow();
});
it("rejects forged match/hash/policy and verifies original OCR text", () => {
  const s = selection(); expect(verifySelection(s, "Supplement Facts")).toEqual(s);
  expect(() => verifySelection(s, "hello")).toThrow();
  expect(() => verifySelection({ ...s, policyFingerprint: "a".repeat(64) }, "Supplement Facts")).toThrow();
});
it("only reviews a closed fully screened product, never an in-flight product", () => {
  const m = { observation, closed: true, imageIds: [image.artifactId] };
  expect(imageProductDecision(m, [selection("hello")])).toMatchObject({ status: "review", code: "SCREEN.NO_LABEL_EVIDENCE", automaticRetry: false });
  expect(imageProductDecision({ ...m, closed: false }, [selection("hello")]).status).toBe("pending");
  expect(imageProductDecision(m, []).status).toBe("pending");
  expect(imageProductDecision(m, [selection()]).status).toBe("selected");
});
it("rejects duplicate and cross-product results", () => {
  const m = { observation, closed: true, imageIds: [image.artifactId] };
  expect(() => imageProductDecision(m, [selection(), selection()])).toThrow();
  expect(() => imageProductDecision({ ...m, observation: { ...observation, brandId: "another" } }, [selection()])).toThrow();
});
