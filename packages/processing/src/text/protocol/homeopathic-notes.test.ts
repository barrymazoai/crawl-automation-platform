import { describe, expect, it } from "vitest";
import { drugLines, drugWire, decodeDrug } from "../../testing/drug-label-fixture.js";
import { defined } from "../../testing/defined.js";

const hpus =
  'The letters "HPUS" indicate that the components in this product are officially ' +
  "monographed in the Homeopathic Pharmacopoeia of the United States.";
const dilution = "**C, K, CK, and X are homeopathic dilutions.";
const notes = [
  '*These "Uses" have not been evaluated by the FDA.',
  '*These "Uses" have not been evaluated by the FDA',
  hpus,
  hpus.replace("this product", "the product"),
  hpus.replace("components", "component(s)"),
  hpus.replace("components", "component").replace("are officially", "is officially"),
  `${hpus} ${dilution}`,
  dilution,
  "(contains less than 10-¹⁴ mg alkaloids)",
  "(contains less than than 10-¹² mg alkaloids)",
  "(Contains less than 10-₁₄ mg aconitine alkaloids)",
  "(contains less than 10⁻⁶ mg emetine alkaloids)",
  "(contains less than 10⁻¹¹ mg antimony)",
  "(contains less than 10⁻¹³ mg anthraquinone glycosides)",
];

describe.each(["footnote", "metadata"] as const)("homeopathic %s", (reason) => {
  it.each(notes)("accepts the full standard note %s", (note) => {
    const wire = drugWire();
    const exclusion = defined(wire.exclusions[1]);
    exclusion.reason = reason;
    exclusion.quote.text = note;
    const lines = drugLines.map((line, index) => (index === 4 ? note : line));
    expect(decodeDrug(wire, lines).codes).toEqual([]);
  });

  it.each([
    `${hpus} Vitamin C 50 mg`,
    '*These "Uses" have not been evaluated by the FDA. Premium strength.',
    "(Contains less than 10-₁₄ mg aconitine alkaloids) Caffeine 100 mg",
    "Contains 100 mg caffeine",
    "(contains more than 10 mg alkaloids)",
    "Relieves cold with thick, yellow discharge*",
  ])("refuses unrecognized or appended content %s", (note) => {
    const wire = drugWire();
    const exclusion = defined(wire.exclusions[1]);
    exclusion.reason = reason;
    exclusion.quote.text = note;
    const lines = drugLines.map((line, index) => (index === 4 ? note : line));
    expect(decodeDrug(wire, lines).codes).toContain("LABEL.COVERAGE_UNCERTAIN");
  });
});
