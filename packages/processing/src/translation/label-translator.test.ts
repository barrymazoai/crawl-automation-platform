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

  it("asks for Spanish the same way, with Spanish label words (KAN-243, amazon.es 2026-11-13)", () => {
    const prompt = labelTranslationPrompt("es", ["de los cuales azúcar", "Dosis (2 comprimidos)"]);
    expect(prompt).toContain("Translate each Spanish text");
    expect(prompt).toContain("de los cuales: of which");
    expect(prompt).not.toContain("Zink: Zinc");
    expect(labelTranslationPrompt("de", ["davon Zink"])).not.toContain("Magnesio");
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
