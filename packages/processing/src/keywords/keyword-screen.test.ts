import { describe, expect, it } from "vitest";
import { DefaultKeywordPolicy, observationIdentity } from "@crawl-automation/v3-contracts";
import { ocrTask } from "../testing/ocr-fixture.js";
import { screenKeywords, verifySelection } from "./keyword-screen.js";

const task = ocrTask();
const screened = (text: string, policy: unknown = DefaultKeywordPolicy) =>
  screenKeywords(
    { observation: observationIdentity(task), image: task.file, ocrOperationId: "ocr-1", text },
    policy,
  );

// Cases carried over from the former keyword module.
describe("keyword screening", () => {
  it.each([
    "Supplement Facts",
    "SUPPLEMENT\nFacts",
    "Nutrition\tFacts",
    "INGREDIENTS:",
    "Other\n ingredients",
    "(Ingredients)",
  ])("matches %j", (text) => expect(screened(text).status).toBe("matched"));

  it.each([
    "",
    "Natural orange flavor",
    "Supplement Faets",
    "ingredient",
    "noningredients",
    "ingredients2",
  ])("never guesses or repairs: %j", (text) => expect(screened(text).status).toBe("not_matched"));

  it("follows an explicit versioned keyword list", () => {
    const narrow = { ...DefaultKeywordPolicy, keywords: ["Nutrition Facts"] };
    const result = screened("ingredients", narrow);
    expect(result.status).toBe("not_matched");
    expect(result.policyFingerprint).not.toBe(screened("ingredients").policyFingerprint);
  });

  it("refuses an image that belongs to another variant", () => {
    const image = { ...task.file, variantId: "other" };
    const input = {
      observation: observationIdentity(task),
      image,
      ocrOperationId: "ocr-1",
      text: "ingredients",
    };
    expect(() => screenKeywords(input)).toThrow();
  });

  it("recomputes a decision from the text and refuses forged ones", () => {
    const selection = screened("Supplement Facts");
    expect(verifySelection(selection, "Supplement Facts")).toEqual(selection);
    expect(() => verifySelection(selection, "hello")).toThrow(
      expect.objectContaining({ code: "SCREEN.EVIDENCE_MISMATCH" }),
    );
    const forged = { ...selection, policyFingerprint: "a".repeat(64) };
    expect(() => verifySelection(forged, "Supplement Facts")).toThrow();
  });
});
