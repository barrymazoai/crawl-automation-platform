import { describe, expect, it } from "vitest";
import { checkedTranslations, labelTranslationPrompt } from "./label-translator.js";

describe("label translation turn (KAN-243, Germany plan option A)", () => {
  it("numbers each printed German text and asks for a faithful English label wording", () => {
    const prompt = labelTranslationPrompt("de", ["davon Zink", "Tagesdosis (2 Kapseln)"]);
    expect(prompt).toContain("Translate each German text");
    expect(prompt).toContain('{"index":0,"text":"davon Zink"}');
    expect(prompt).toContain("never add, drop, reorder or explain anything");
    expect(prompt).toContain("Keep brand and trademark names");
  });

  it("keeps an answer only when it translates every text exactly once", () => {
    const texts = ["davon Zink", "Zutaten:"];
    expect(
      checkedTranslations(texts, {
        translations: [
          { index: 1, english: "Ingredients:" },
          { index: 0, english: "of which Zinc" },
        ],
      }),
    ).toEqual([
      { text: "davon Zink", english: "of which Zinc" },
      { text: "Zutaten:", english: "Ingredients:" },
    ]);
    for (const translations of [
      [{ index: 0, english: "of which Zinc" }],
      [
        { index: 0, english: "of which Zinc" },
        { index: 0, english: "Zinc" },
      ],
      [
        { index: 0, english: "of which Zinc" },
        { index: 2, english: "Ingredients:" },
      ],
    ]) {
      expect(() => checkedTranslations(texts, { translations })).toThrow(
        expect.objectContaining({ code: "BRAND_RESEARCH.ANSWER_INVALID" }),
      );
    }
  });
});
