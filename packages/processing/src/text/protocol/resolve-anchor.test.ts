import { describe, expect, it } from "vitest";
import { evidenceLines } from "./evidence-lines.js";
import { resolveAnchor } from "./resolve-anchor.js";

const setup = (lines: string[]) => {
  const text = lines.join("\n");
  const source = { text, lines: evidenceLines({ range: { start: 0, end: text.length } }, text) };
  return { text, source };
};
const anchor = (line: number, text: string) => ({ fromLine: line, toLine: line, text });

describe("resolveAnchor", () => {
  it("finds a quote printed once, with any whitespace between its words", () => {
    const { source } = setup(["Serving Size", "1 Level   Scoop (5 grams)"]);

    const quote = resolveAnchor(anchor(2, "1 Level Scoop (5 grams)"), source);

    expect(quote.text).toBe("1 Level   Scoop (5 grams)");
    expect(source.text.slice(quote.start, quote.end)).toBe(quote.text);
  });

  it("refuses a quote that is not printed on the cited lines", () => {
    const { source } = setup(["Calories 20", "Ribose 5 g"]);

    expect(() => resolveAnchor(anchor(1, "Ribose"), source)).toThrow(
      expect.objectContaining({ code: "TEXT.CITATION_INVALID" }),
    );
  });

  it("without context, a repeated quote is still refused (the earlier rule)", () => {
    const { source } = setup(["Chicken Meal, Chicken, Chicken Fat"]);

    expect(() => resolveAnchor(anchor(1, "Chicken"), source)).toThrow(
      expect.objectContaining({ code: "TEXT.CITATION_INVALID" }),
    );
  });

  it("with context, a repeated list item lands on its whole list entry", () => {
    const { source } = setup(["Chicken Meal, Chicken, Chicken Fat"]);

    const quote = resolveAnchor(anchor(1, "Chicken"), source, { listItem: true });

    expect(source.text.slice(quote.start - 2, quote.end + 1)).toBe(", Chicken,");
  });

  it("takes the first free occurrence after the previous item, never one already quoted", () => {
    const { source } = setup(["Banana, Rice, Banana"]);
    const first = resolveAnchor(anchor(1, "Banana"), source, { listItem: true });

    const second = resolveAnchor(anchor(1, "Banana"), source, {
      listItem: true,
      after: first.end,
      taken: [first],
    });

    expect(second.start).toBeGreaterThan(first.start);
  });

  it("lets a row name enclose the row's own amount", () => {
    const { source } = setup(["Includes 5 g Added Sugars 10%"]);

    const quote = resolveAnchor(anchor(1, "Includes Added Sugars"), source, {
      enclosed: "5 g",
    });

    expect(quote.text).toBe("Includes 5 g Added Sugars");
  });

  it("refuses a line range outside the text", () => {
    const { source } = setup(["Calories 20"]);

    expect(() => resolveAnchor({ fromLine: 2, toLine: 3, text: "20" }, source)).toThrow(
      expect.objectContaining({ code: "TEXT.CITATION_INVALID" }),
    );
  });
});
