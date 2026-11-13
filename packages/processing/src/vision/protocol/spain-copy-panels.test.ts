import { amazonLabelFormats } from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { transcriptCandidate } from "./label-transcript-candidate.js";
import { labelTranscriptPromptFor, labelTranscriptWireSchema } from "./label-transcript-wire.js";

/**
 * KAN-243 (owner 2026-11-13, "加西班牙文"): amazon.es labels read in the Spanish food-supplement format, on the ES sections
 * of the importers' multilingual stickers as printed on real amazon.es gallery images captured 2026-11-13
 * (docs/plans/KAN-243-spain-plan.md §5). The copy keeps Spanish.
 */
const SPAIN = amazonLabelFormats("amazon-es");
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
type Built = ReturnType<typeof transcriptCandidate>;
type Candidate = Exclude<Built, { reason: string }>["candidate"];
const text = (field: { text: string } | null | undefined) => field?.text ?? null;
const rowsOf = (candidate: Candidate) =>
  (candidate.formula?.columns[0]?.rows ?? []).map((each) => [
    each.name.text,
    text(each.amount),
    text(each.dailyValue),
  ]);
const summary = (candidate: Candidate) => ({
  serving: text(candidate.formula?.servingSize),
  heading: text(candidate.formula?.columns[0]?.heading),
  rows: rowsOf(candidate),
  other: text(candidate.otherIngredients?.items[0]),
});
const read = (built: Built) => ("reason" in built ? built.reason : summary(built.candidate));

describe("amazon.es: Spanish food-supplement labels", () => {
  it("is read in the US, UK and Spanish formats, and the copy is told to keep Spanish and prefer English", () => {
    expect(SPAIN).toEqual(["us-facts/1", "in-nutritional-information/3", "es-food-supplement/1"]);
    const prompt = labelTranscriptPromptFor(SPAIN);
    expect(prompt).toContain("exactly as printed in Spanish: never translate");
    expect(prompt).toContain("otherwise the Spanish (ES) section only");
    expect(prompt).not.toContain("German (DE) section");
    expect(labelTranscriptPromptFor(amazonLabelFormats("amazon-de"))).not.toContain("Spanish");
  });

  it("reads the importer's Ingredientes table by its Dosis and %VRN headers (Doctor's Best B09BVX2XS7)", () => {
    const table = panel(
      null,
      { serving: [], headers: ["Ingredientes", "Dosis (2 comprimidos)", "%VRN*"] },
      [
        ["Magnesio", "200mg", "53%"],
        [
          "*= Porcentaje de los valores de referencia de nutrientes según el Reglamento (UE) nº 1169/2011",
          "",
          "",
        ],
      ],
    );
    const ingredientes =
      "Quelato de lisinato de magnesio, agente de carga: Celulosa microcristalina, Estabilizador: Carboximetilcelulosa sódica reticulada, Antiaglomerante: Sales de magnesio de ácidos grasos, Emulsionante: Ácidos grasos, Agente de recubrimiento: Hidroxipropilcelulosa.";
    const built = transcriptCandidate(
      wire([table], { heading: "Ingredientes:", list: ingredientes }),
      policy,
      SPAIN,
    );
    expect(read(built)).toMatchObject({
      heading: "Dosis (2 comprimidos)",
      rows: [["Magnesio", "200mg", "53%"]],
    });
    expect("reason" in built ? null : built.candidate.otherIngredients?.heading?.text).toBe(
      "Ingredientes:",
    );
  });

  it("reads a Dosis diaria table with its de los cuales rows and the serving line (Nordic Naturals B0CF5QJMFK)", () => {
    const table = panel(
      null,
      {
        serving: [
          "Recomendación de consumo: Mezcle 2 cucharaditas al día en una bebida de su elección y bébala.",
        ],
        headers: ["Ingredientes", "Dosis diaria (2 cucharaditas)", "%NRV*"],
      },
      [
        ["Energía", "20kcal / 83,68kJ", "1%"],
        ["Grasa", "0g", "0%"],
        ["de los cuales ácidos grasos saturados", "0g", "0%"],
        ["Proteínas", "4g", "8%"],
        ["Vitamina C", "45mg", "56%"],
        ["Colágeno hidrolizado", "4200mg", "**"],
        ["** = Necesidad diaria no determinada", "", ""],
      ],
    );
    const built = transcriptCandidate(wire([table]), policy, SPAIN);
    expect(read(built)).toMatchObject({
      serving: "Mezcle 2 cucharaditas al día en una bebida de su elección y bébala.",
      heading: "Dosis diaria (2 cucharaditas)",
      rows: [
        ["Energía", "20kcal / 83,68kJ", "1%"],
        ["Grasa", "0g", "0%"],
        ["de los cuales ácidos grasos saturados", "0g", "0%"],
        ["Proteínas", "4g", "8%"],
        ["Vitamina C", "45mg", "56%"],
        ["Colágeno hidrolizado", "4200mg", "**"],
      ],
    });
  });
});
