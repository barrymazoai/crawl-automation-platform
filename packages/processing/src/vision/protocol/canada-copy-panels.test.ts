import { amazonLabelFormats } from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { transcriptCandidate } from "./label-transcript-candidate.js";
import { labelTranscriptWireSchema } from "./label-transcript-wire.js";

/**
 * KAN-243 (owner 2026-11-11): amazon.ca labels read in India's composition format /3, on panels as printed on real
 * amazon.ca gallery images captured 2026-11-11 (docs/plans/KAN-243-canada-plan.md §1).
 */
const CANADA = amazonLabelFormats("amazon-ca");
const UK = amazonLabelFormats("amazon-uk");
const policy = { allowNoOtherIngredientsSection: true };
const row = (...cells: string[]) => ({ cells, indent: 0, bold: false });
const panel = (
  heading: string | null,
  lines: { serving: string[]; headers: string[] },
  rows: string[][],
) => ({
  heading,
  servingLines: lines.serving,
  columnHeaders: lines.headers,
  rows: rows.map((cells) => row(...cells)),
  footnotes: [],
});
const wire = (panels: unknown[], other: { heading: string; list: string } | null = null) =>
  labelTranscriptWireSchema.parse({
    codec: "label-visual-wire/4",
    panels,
    otherIngredientsHeading: other?.heading ?? null,
    otherIngredients: other?.list ?? null,
    otherIngredientsState: other ? "present" : "not_fully_visible",
    wholeLabelVisible: false,
    issues: [],
  });
const read = (built: ReturnType<typeof transcriptCandidate>) =>
  "reason" in built
    ? built.reason
    : {
        serving: built.candidate.formula?.servingSize?.text ?? null,
        rows: built.candidate.formula?.columns[0]?.rows.map((each) => [
          each.name.text,
          each.amount?.text ?? null,
        ]),
      };

// Sports Research Omega-3 Fish Oil (B07DX89ZHN): the "Product Facts / Info-produit" box.
const productFacts = panel(
  "Medicinal ingredients / Ingrédients médicinaux",
  { serving: ["(In each softgel)"], headers: ["", ""] },
  [
    ["Fish oil (Gadidae - whole)", "1250 mg"],
    ["Providing Omega-3 Fatty Acids", "1040 mg"],
    ["EPA (Eicosapentaenoic acid)", "690 mg"],
    ["DHA (Docosahexaenoic acid)", "260 mg"],
  ],
);

describe("amazon.ca: Health Canada medicinal ingredients", () => {
  it("is read in India's composition format /3; the UK keeps /2", () => {
    expect(CANADA).toEqual(["us-facts/1", "in-composition/3"]);
    expect(UK).toContain("in-composition/2");
  });

  it("reads a Product Facts box: the (In each …) line is the serving, each medicinal ingredient a row", () => {
    const built = transcriptCandidate(
      wire([productFacts], {
        heading: "Non-medicinal ingredients",
        list: "Fish gelatin, glycerin, purified water, tocopherols.",
      }),
      policy,
      CANADA,
    );
    expect(read(built)).toEqual({
      serving: "softgel",
      rows: [
        ["Fish oil (Gadidae - whole)", "1250 mg"],
        ["Providing Omega-3 Fatty Acids", "1040 mg"],
        ["EPA (Eicosapentaenoic acid)", "690 mg"],
        ["DHA (Docosahexaenoic acid)", "260 mg"],
      ],
    });
  });

  it("reads an Each tablet contains list and leaves its French heading lines out (Webber Naturals B00B4JDYHC)", () => {
    const list = panel(
      null,
      { serving: ["Each tablet contains: / Chaque comprimé contient :"], headers: ["", ""] },
      [
        ["Chaque comprimé contient :", ""],
        ["Vitamin D3 (cholecalciferol)", "1000 IU (25 mcg)"],
      ],
    );
    expect(read(transcriptCandidate(wire([list]), policy, CANADA))).toEqual({
      serving: "tablet",
      rows: [["Vitamin D3 (cholecalciferol)", "1000 IU (25 mcg)"]],
    });
  });

  it("reads a medicinal-ingredient table by its bilingual headers (Jacked Factory creatine B08DH161T6)", () => {
    const table = panel(
      "Medicinal Ingredients",
      {
        serving: ["Serving Size / Portions : 1 scoop / cuillère"],
        headers: ["", "Amount Per Serving / Quantité par portion", "%DV / %VQ"],
      },
      [["Creatine Monohydrate", "5000mg", "†"]],
    );
    const built = transcriptCandidate(wire([table]), policy, CANADA);
    expect(read(built)).toMatchObject({ rows: [["Creatine Monohydrate", "5000mg"]] });
  });
});
