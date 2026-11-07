import { describe, expect, it } from "vitest";
import { transcriptCandidate } from "./label-transcript-candidate.js";
import { labelTranscriptWireSchema } from "./label-transcript-wire.js";

/** Owner 2026-11-07 (AS-IT-IS ATOM whey on amazon.in, copied from the stored answer). */
const policy = { allowNoOtherIngredientsSection: true };
const row = (...cells: string[]) => ({ cells, indent: 0, bold: false });
const facts = {
  heading: "NUTRITIONAL INFORMATION",
  servingLines: ["Serving Size: 1 scoop (36 g)"],
  columnHeaders: ["Nutrients", "Amount Per Serving", "% Daily Value"],
  rows: [row("Energy", "140kcal", "7%"), row("Protein", "27g", "50%")],
  footnotes: [],
};
const amino = (heading: string) => ({
  heading,
  servingLines: [],
  columnHeaders: ["Amino Acid", "mg"],
  rows: [row("Leucine", "2700"), row("Valine", "1500")],
  footnotes: [],
});
const wire = (panels: unknown[]) =>
  labelTranscriptWireSchema.parse({
    codec: "label-visual-wire/4",
    panels,
    otherIngredientsHeading: null,
    otherIngredients: null,
    otherIngredientsState: "not_fully_visible",
    wholeLabelVisible: false,
    issues: [],
  });
const amounts = (built: ReturnType<typeof transcriptCandidate>) =>
  "reason" in built
    ? built.reason
    : built.candidate.formula?.columns[0]?.rows.map((read) => [read.name.text, read.amount?.text]);

describe("a facts panel printed beside an amino acid profile", () => {
  it("reads the facts panel alone", () => {
    const built = transcriptCandidate(
      wire([facts, amino("TYPICAL AMINO ACID PER SERVING"), amino("AMINO ACID PROFILE**")]),
      policy,
    );

    expect(amounts(built)).toEqual([
      ["Energy", "140kcal"],
      ["Protein", "27g"],
    ]);
  });

  it("still does not choose between two facts panels", () => {
    expect(
      amounts(transcriptCandidate(wire([facts, { ...facts, heading: "Per 2 tablets" }]), policy)),
    ).toBe("panels: 2");
  });

  it("leaves a lone panel to the rules as before, whatever its heading", () => {
    expect(amounts(transcriptCandidate(wire([amino("AMINO ACID PROFILE")]), policy))).not.toBe(
      "panels: 1",
    );
  });
});
