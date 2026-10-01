import { describe, expect, it } from "vitest";
import { simpleLabel, decodeSimple } from "../../testing/simple-label.js";

const notes = [
  "**1 CFU = 1 Colony Forming Unit",
  "† Daily Value not established.** SPU - serratiopeptidase activity units.*** FU - fibrinolytic activity units",
  "¹At time of manufacture. + Daily Value not established.",
  "*Percent Daily Values (%DV) are based on a 2,000 calorie diet.",
  "† %DV based on a 2,000-calorie diet",
  "[**Asporotate™ denotes Aspartate, Citrate, Orotate (milk, soy).]",
  "*Nutrient fermented from Saccharomyces cerevisiae **Enzyme Activated Mineral",
  "FU - enzyme activity in fibrinolytic units",
  "**SPU - serratiopeptidase activity units.",
  "† Daily Value not established.**SPU - serratiopeptidase activity units.",
  "* Reported as triglycerides.",
  "† Total Caffeine Yield: 304 mg per serving.",
  "These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure or prevent any disease.",
];
function withNote(note: string, reason: "footnote" | "metadata" | "noise" | "marketing") {
  const fixture = simpleLabel({ note });
  fixture.wire.exclusions.push({ quote: { fromLine: 8, toLine: 8, text: note }, reason });
  return decodeSimple(fixture);
}

describe.each(["footnote", "metadata", "noise"] as const)("label notes tagged %s", (reason) => {
  it.each(notes)("preserves the complete cited note %s", (note) => {
    const result = withNote(note, reason);
    expect(result.codes).toEqual([]);
    expect(result.candidate.exclusions[0]?.quote.text).toBe(note);
  });
  it.each([
    "About this item",
    "Supports heart health",
    "Supplying 300 mg",
    "FU - enzyme activity in fibrinolytic units. Zinc 5 mg",
    "† Total Caffeine Yield: 304 mg per serving. Gives all-day energy.",
  ])("refuses %s", (note) => {
    expect(withNote(note, reason).codes).toContain("LABEL.COVERAGE_UNCERTAIN");
  });
});
it.each(notes)("still refuses marketing exclusions: %s", (note) => {
  expect(withNote(note, "marketing").codes).toContain("LABEL.COVERAGE_UNCERTAIN");
});
