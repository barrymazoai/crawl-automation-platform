import { describe, expect, it } from "vitest";
import { decodeLabelText } from "../../text/protocol/label-decoder.js";
import { transcriptAttempt } from "./transcript-answer.js";

// Synthetic panels in the shapes the 2026-11-04 replay met: Nature's Way's div grid (one cell per text line, as the
// label core prints it) and GNC's <table>. The text is what the label core would hand the text step.
const cell = (text: string, column: number) =>
  `<div class="nw-pdp-ingredient-row-col-${column}">${text}</div>`;
const gridRow = (...cells: string[]) =>
  `<div class="nw-pdp-ingredient-row">${cells.map((text, at) => cell(text, at + 1)).join("")}</div>`;

function attempt(html: string, lines: string[]) {
  const text = lines.join("\n");
  const range = { start: 0, end: text.length };
  const result = transcriptAttempt({ range }, text, html);
  const decoded = result.answer
    ? decodeLabelText({
        scope: { range },
        text,
        response: result.answer,
        policyVersion: "label-text/6",
      })
    : null;
  const rows = (decoded?.candidate.formula?.columns[0]?.rows ?? []).map((row) => ({
    kind: row.kind,
    name: row.name.text,
    amount: row.amount?.text ?? null,
    parent: row.parentRowIndex,
  }));
  return { ...result, decoded, rows };
}

const multivitamin = {
  html: [
    gridRow("Serving Size:", "1 tablet"),
    gridRow("Amount/Serving", "%DV"),
    gridRow("Folate", "400 mcg dfe", "100%"),
    gridRow("(240 mcg Folic Acid)", "--", "--"),
    gridRow("Sodium", "15 mg", "1%"),
    gridRow("Men’s Blend: Saw Palmetto (berry), Tomato", "101 mg", "**"),
    "<p>** Daily Value (DV) not established</p>",
    "<h4>Other Ingredients</h4><p>cellulose, stearic acid, silica</p>",
  ].join(""),
  lines: [
    "Supplement Facts",
    "Serving Size:\t1 tablet",
    "Amount/Serving",
    "%DV",
    "Folate",
    "400 mcg dfe",
    "100%",
    "(240 mcg Folic Acid)",
    "--",
    "--",
    "Sodium",
    "15 mg",
    "1%",
    "Men’s Blend: Saw Palmetto (berry), Tomato",
    "101 mg",
    "**",
    "",
    "** Daily Value (DV) not established",
    "",
    "Other Ingredients",
    "cellulose, stearic acid, silica",
    "Alive!® Men's Multivitamin Does Not Contain",
    "Gluten, Artificial Colors",
    "UPC: 033674156919",
  ],
};

describe("transcriptAttempt", () => {
  it("reads a div-grid panel into rows the label checks accept", () => {
    const { decoded, rows } = attempt(multivitamin.html, multivitamin.lines);

    expect(decoded?.status).toBe("candidate");
    expect(rows).toEqual([
      { kind: "nutrient", name: "Folate", amount: "400 mcg dfe", parent: null },
      { kind: "nutrient", name: "Folic Acid", amount: "240 mcg", parent: null },
      { kind: "nutrient", name: "Sodium", amount: "15 mg", parent: null },
      { kind: "blend_total", name: "Men’s Blend", amount: "101 mg", parent: null },
      { kind: "blend_component", name: "Saw Palmetto (berry)", amount: null, parent: 3 },
      { kind: "blend_component", name: "Tomato", amount: null, parent: 3 },
    ]);
    expect(decoded?.candidate.otherIngredients?.items.map((item) => item.text)).toEqual([
      "cellulose",
      "stearic acid",
      "silica",
    ]);
  });

  it("gives each listed blend member the dose it prints before its name (MegaFood on Swanson)", () => {
    const members =
      "250 mg Holy basil leaf extract (Ocimum sanctum), 250 mg Sensoril® ashwagandha root & leaf extract (Withania somnifera/ 10% Withanolides), 150 mg Coleus forskohlii root extract (Coleus forskohlii)";
    const pre = [
      "Supplement Facts",
      "",
      "Serving Size 2 Tablets",
      "",
      "Amount Per Serving\t% Daily Value",
      "Herb Blend 650 mg\t**",
      members,
      "L-Tyrosine 300 mg\t**",
      "",
      "Other Ingredients: Microcrystalline cellulose, hypromellose.",
    ].join("\n");
    const lines = pre.split("\n").map((line) => line.replace(/\t/g, " "));

    const { decoded, rows } = attempt(`<pre>${pre}</pre>`, lines);

    expect(decoded?.status).toBe("candidate");
    expect(rows).toEqual([
      { kind: "blend_total", name: "Herb Blend", amount: "650 mg", parent: null },
      {
        kind: "blend_component",
        name: "Holy basil leaf extract (Ocimum sanctum)",
        amount: "250 mg",
        parent: 0,
      },
      {
        kind: "blend_component",
        name: "Sensoril® ashwagandha root & leaf extract (Withania somnifera/ 10% Withanolides)",
        amount: "250 mg",
        parent: 0,
      },
      {
        kind: "blend_component",
        name: "Coleus forskohlii root extract (Coleus forskohlii)",
        amount: "150 mg",
        parent: 0,
      },
      { kind: "nutrient", name: "L-Tyrosine", amount: "300 mg", parent: null },
    ]);
  });

  it("puts strains under a sub-heading in the dosed blend, with each '--' cell left out", () => {
    const html = [
      gridRow("Probiotic Blend 30 Billion CFU:", "520 mg", "**"),
      gridRow("Lactobacilli Blend:", "", ""),
      gridRow("Lactobacillus casei Lc-11®", "--", "--"),
      gridRow("Lactobacillus rhamnosus GG", "--", "--"),
      gridRow("Chicory (root) Fiber", "50 mg", "**"),
      "<h4>Other Ingredients</h4><p>hypromellose, silica</p>",
    ].join("");
    const lines = [
      "Supplement Facts",
      "Probiotic Blend 30 Billion CFU:",
      "520 mg",
      "**",
      "Lactobacilli Blend:",
      "Lactobacillus casei Lc-11®",
      "--",
      "--",
      "Lactobacillus rhamnosus GG",
      "--",
      "--",
      "Chicory (root) Fiber",
      "50 mg",
      "**",
      "** Daily Value (DV) not established",
      "Other Ingredients",
      "hypromellose, silica",
    ];

    const { decoded, rows } = attempt(html, lines);

    expect(decoded?.status).toBe("candidate");
    expect(rows.map((row) => [row.kind, row.parent])).toEqual([
      ["blend_total", null],
      ["group_header", null],
      ["blend_component", 0],
      ["blend_component", 0],
      ["nutrient", null],
    ]);
  });

  it("reads a GNC table whose blend list sits unindented in the row below the blend", () => {
    const html = `<table>
      <tr><td><b>Vitamin D3</b></td><td>25 mcg</td><td>125%</td></tr>
      <tr><td><strong>Stimulant Complex</strong></td><td>750 mg</td><td>**</td></tr>
      <tr><td colspan="2">Caffeine Anhydrous, Kola Nut (seed), Guarana (seed)</td><td>**</td></tr>
    </table><p><b>Other Ingredients:</b> Cellulose, Gelatin.</p>`;
    const lines = [
      "Supplement Facts",
      "Vitamin D3",
      "25 mcg",
      "125%",
      "Stimulant Complex",
      "750 mg",
      "**",
      "Caffeine Anhydrous, Kola Nut (seed), Guarana (seed)",
      "**",
      "** Daily Value not established.",
      "Other Ingredients: Cellulose, Gelatin.",
    ];

    const { decoded, rows } = attempt(html, lines);

    expect(decoded?.status).toBe("candidate");
    expect(rows.map((row) => [row.name, row.parent])).toEqual([
      ["Vitamin D3", null],
      ["Stimulant Complex", null],
      ["Caffeine Anhydrous", 1],
      ["Kola Nut (seed)", 1],
      ["Guarana (seed)", 1],
    ]);
  });

  it("reads a plain-text <pre> panel line by line (Swanson)", () => {
    const pre = [
      "Supplement Facts",
      "",
      "Serving Size 1 tablet",
      "",
      "Amount Per Serving\t% Daily Value",
      "Calories 10\t",
      "Vitamin B-12 (as Cyanocobalamin) 1,000 mcg\t41,667%",
      "Calcium (as Dibasic Calcium Phosphate) 120 mg\t10%",
      "",
      "Other Ingredients: Cellulose Gel, Stearic Acid.",
      "",
      "Suggested Use: 1 tablet daily.",
    ].join("\n");
    const lines = [
      "Supplement Facts",
      "",
      "Serving Size 1 tablet",
      "",
      "Amount Per Serving % Daily Value",
      "Calories 10",
      "Vitamin B-12 (as Cyanocobalamin) 1,000 mcg 41,667%",
      "Calcium (as Dibasic Calcium Phosphate) 120 mg 10%",
      "",
      "Other Ingredients: Cellulose Gel, Stearic Acid.",
    ];

    const { decoded, rows } = attempt(`<pre>${pre}</pre>`, lines);

    expect(decoded?.status).toBe("candidate");
    expect(rows.map((row) => [row.name, row.amount])).toEqual([
      ["Calories", "10"],
      ["Vitamin B-12 (as Cyanocobalamin)", "1,000 mcg"],
      ["Calcium (as Dibasic Calcium Phosphate)", "120 mg"],
    ]);
  });

  it("reads CSS grid rows of <p> cells, not the flex boxes around them (natrol)", () => {
    const grid = (...cells: string[]) =>
      `<div class="grid grid-cols-[55%_1fr_1fr]">${cells.map((cell) => `<p class="text-base">${cell}</p>`).join("")}</div>`;
    const html = `<div class="flex flex-col"><div class="flex flex-col"><h3>Nutrition Facts</h3></div>
      <div class="flex flex-col">${grid("Biotin", "10,000mcg", "33,333%")}${grid("Calcium", "66mg", "5%")}</div></div>
      <p><b>Other Ingredients:</b> Cellulose.</p>`;
    const lines = [
      "Nutrition Facts",
      "Amount Per Serving",
      "%DV",
      "Biotin",
      "10,000mcg",
      "33,333%",
      "Calcium",
      "66mg",
      "5%",
      "Other Ingredients: Cellulose.",
    ];

    const { decoded, rows } = attempt(html, lines);

    expect(decoded?.status).toBe("candidate");
    expect(rows.map((row) => [row.name, row.amount])).toEqual([
      ["Biotin", "10,000mcg"],
      ["Calcium", "66mg"],
    ]);
  });

  it("never places a value inside a longer number ('10' is not the start of '100 mg')", () => {
    const pre = "Amount Per Serving\nCalories 10\nZinc 100 mg\n";
    const lines = ["Amount Per Serving", "Calories", "Zinc 100 mg"];

    const result = attempt(`<pre>${pre}</pre>`, lines);

    expect(result.answer).toBeNull();
    expect(result.reason).toBe("value not printed after its name: Calories");
  });

  it("leaves the panel to the model when a printed line among the rows is not explained", () => {
    const lines = [...multivitamin.lines];
    lines.splice(11, 0, "Calcium 200 mg");

    const result = attempt(multivitamin.html, lines);

    expect(result.answer).toBeNull();
    expect(result.reason).toMatch(/^unexplained line: Calcium/);
  });

  it("leaves the panel to the model when a copied row is not printed in the label text", () => {
    const lines = multivitamin.lines.filter((line) => line !== "Sodium");

    const result = attempt(multivitamin.html, lines);

    expect(result.answer).toBeNull();
    expect(result.reason).toBe("name not printed in a line: Sodium");
  });

  it("gives no answer for a page without row structure", () => {
    const result = attempt("<p>Vitamin C 500 mg supports immunity.</p>", ["Vitamin C 500 mg"]);

    expect(result).toMatchObject({ answer: null, reason: "no row structure" });
  });
});
