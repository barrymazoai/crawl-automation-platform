import { describe, expect, it } from "vitest";
import { drugExclusionAllowed } from "./drug-label.js";

const sections = [
  "Uses\nRelieves cold with thick, yellow discharge*",
  "Warnings\nStop use and ask a doctor if\nsymptoms persist for more than 3 days or worsen.\n" +
    "If pregnant or breast-feeding,\nask a health professional before use.\n" +
    "Keep out of reach of children.",
  "Directions\n■ Adults and children: At the onset of symptoms, dissolve 5 pellets under " +
    "the tongue 3 times a day until symptoms are relieved or as directed by a doctor.",
  "Other Information\nDo not use if pellet dispenser seal is broken.\nContains approx. 80 pellets",
  "Questions?\nCall the manufacturer",
];
const active = "Arnica montana 30C HPUS Relieves muscle pain";
const inactive = "Inactive ingredients\nlactose, sucrose";
const text = [
  "Drug Facts",
  "Active ingredient (in each tablet)",
  active,
  ...sections.slice(0, 4),
  inactive,
  sections[4],
].join("\n");

function allowed(value: string) {
  const start = text.indexOf(value);
  expect(start).toBeGreaterThanOrEqual(0);
  return drugExclusionAllowed(
    { reason: "directions", quote: { text: value, start, end: start + value.length } },
    text,
  );
}

describe("Drug Facts section exclusions in full context", () => {
  it.each(sections)("accepts the whole section %s", (section) => {
    expect(allowed(section)).toBe(true);
  });

  it.each(sections.flatMap((section) => section.split("\n")))(
    "accepts the separately quoted line %s in its section",
    (line) => {
      expect(allowed(line)).toBe(true);
    },
  );

  it.each([active, inactive, "lactose, sucrose", `${sections[3]}\n${inactive}`])(
    "does not excuse active or inactive ingredient content %s",
    (value) => {
      expect(allowed(value)).toBe(false);
    },
  );

  it("does not recognize an unscoped symptom claim as a section", () => {
    const value = "Relieves cold with thick, yellow discharge*";
    expect(
      drugExclusionAllowed(
        { reason: "directions", quote: { text: value, start: 0, end: value.length } },
        value,
      ),
    ).toBe(false);
  });
});
