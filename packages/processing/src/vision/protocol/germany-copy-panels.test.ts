import { amazonLabelFormats } from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { transcriptCandidate } from "./label-transcript-candidate.js";
import { labelTranscriptPromptFor, labelTranscriptWireSchema } from "./label-transcript-wire.js";

/**
 * KAN-243 (owner 2026-11-11): amazon.de labels read in the EU food-supplement format, on panels as printed on real
 * amazon.de gallery images captured 2026-11-11 (docs/plans/KAN-243-germany-plan.md §1). The copy keeps German.
 */
const GERMANY = amazonLabelFormats("amazon-de");
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

describe("amazon.de: German food-supplement labels", () => {
  it("is read in the US, UK and EU formats, and the copy is told to keep German", () => {
    expect(GERMANY).toEqual(["us-facts/1", "in-nutritional-information/3", "eu-food-supplement/1"]);
    expect(labelTranscriptPromptFor(GERMANY)).toContain("never translate");
  });

  it("reads an importer's Inhaltsstoffe table by its Tagesdosis and %NRV headers (Doctor's Best B09LR81NNL)", () => {
    const table = panel(
      null,
      { serving: [], headers: ["Inhaltsstoffe", "Tagesdosis (2 Kapseln)", "%NRV*"] },
      [
        ["PepZin GI® Zink-L-Carnosin", "75mg", "**"],
        ["davon Zink", "16mg", "160%"],
        ["davon L-Carnosin", "59mg", "**"],
        [
          "* = Prozentsatz der Nährstoff-Referenzwerte gemäß der Verordnung (EU) Nr. 1169/2011",
          "",
          "",
        ],
        ["** = Tageswert nicht ermittelt", "", ""],
      ],
    );
    const zutaten =
      "Zink-L-Carnosin-Komplex (PepZin GI®), Füllstoff: mikrokristalline Cellulose; Überzugsmittel: Hydroxypropylmethylcellulose (Kapsel); Trennmittel: Magnesiumsalze von Speisefettsäuren (pflanzliche Quelle), Siliciumdioxid";
    const built = transcriptCandidate(
      wire([table], { heading: "Zutaten:", list: zutaten }),
      policy,
      GERMANY,
    );
    expect(read(built)).toMatchObject({
      heading: "Tagesdosis (2 Kapseln)",
      rows: [
        ["PepZin GI® Zink-L-Carnosin", "75mg", "**"],
        ["davon Zink", "16mg", "160%"],
        ["davon L-Carnosin", "59mg", "**"],
      ],
      other: zutaten,
    });
  });

  it("reads a table without a percentage column (Nordic Naturals Ultimate Omega B0C7KT42M7)", () => {
    const table = panel(
      null,
      { serving: [], headers: ["Inhaltsstoffe", "Tagesdosis (2 Weichkapseln)"] },
      [
        ["Gesamt-Omega-3", "1280mg"],
        ["davon EPA", "650mg"],
        ["davon DHA", "450mg"],
      ],
    );
    expect(read(transcriptCandidate(wire([table]), policy, GERMANY))).toMatchObject({
      heading: "Tagesdosis (2 Weichkapseln)",
      rows: [
        ["Gesamt-Omega-3", "1280mg", null],
        ["davon EPA", "650mg", null],
        ["davon DHA", "450mg", null],
      ],
    });
  });

  it("reads a German brand's Verzehrempfehlung line as the serving and its pack count (WeightWorld B091GB1NP1)", () => {
    // Its amount column prints no header (the name column is headed "Nährwertangaben pro Portion"); placing an unheaded
    // amount column is a shared column rule, left as it is (German brands are not our companies' brands).
    const table = panel(
      "Nährstofftabelle",
      {
        serving: ["Verzehrempfehlung: 1 Tablette alle 2 Tage | Portionen pro Packung: 365"],
        headers: ["Nährwertangaben pro Portion", "Menge pro Tablette", "%NRV*"],
      },
      [
        ["Vitamin K2 (als Menachinon)", "200µg", "266"],
        ["Vitamin D3 (als Cholecalciferol)", "50µg (2000IE)", "1000"],
        ["*Nährstoffbezugswert", "", ""],
      ],
    );
    const built = transcriptCandidate(wire([table]), policy, GERMANY);
    expect(read(built)).toMatchObject({
      serving: "1 Tablette alle 2 Tage",
      rows: [
        ["Vitamin K2 (als Menachinon)", "200µg", "266"],
        ["Vitamin D3 (als Cholecalciferol)", "50µg (2000IE)", "1000"],
      ],
    });
    expect("reason" in built ? null : built.candidate.formula?.servingsPerContainer?.text).toBe(
      "365",
    );
  });
});
