import { expect, it } from "vitest";
import { type LabelImageCandidate } from "@crawl-automation/v3-contracts";
import { assemblySetup } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import { rowsOf, signal } from "../testing/merge-fixture.js";
import { agreementCandidate, agreementField } from "./label-agreement-fixture.js";
import { mergeLabelProduct } from "./label-merge.js";
import { partialLabelConflicts } from "./partial-label.js";

type FormulaRow = ReturnType<typeof rowsOf>[number];
const fact = (name: string, amount: string | null, dv: string | null = null): FormulaRow => ({
  kind: "nutrient",
  name: agreementField(name),
  amount: amount ? agreementField(amount) : null,
  amountStatus: amount ? "printed" : "not_declared",
  dailyValue: dv ? agreementField(dv) : null,
  parentRowIndex: null,
});
const component = (name: string, amount: string, parentRowIndex: number): FormulaRow => ({
  ...fact(name, amount, "†"),
  kind: "blend_component",
  parentRowIndex,
});
const group = (name: string): FormulaRow => ({
  ...fact(name, null),
  kind: "group_header",
  amountStatus: "not_applicable",
});

function panel(rows: FormulaRow[], serving: string | null, count: string | null) {
  const candidate = agreementCandidate();
  const formula = defined(candidate.formula);
  formula.servingSize = serving ? agreementField(serving) : null;
  formula.servingsPerContainer = count ? agreementField(count) : null;
  defined(formula.columns[0]).rows = rows;
  if (!serving) {
    defined(formula.columns[0]).heading = null;
  }
  return candidate;
}

/** The upper half of a Facts panel: serving line and the first rows, no ingredient list (partial: formula only). */
function upperHalf(): LabelImageCandidate {
  return {
    ...panel(
      [
        fact("Vitamin A (as beta carotene)", "1000 mcg RAE", "111%"),
        fact("Vitamin C (as ascorbic acid)", "120 mg", "133%"),
        fact("Lutein", "50 mcg", "*"),
      ],
      "1 Tablet",
      "90",
    ),
    otherIngredients: null,
    ingredientsComplete: false,
    issues: [{ code: "INGREDIENTS_MISSING", detail: "Other Ingredients section is not visible." }],
  };
}

/** The lower half photographed on its own: herbal rows without the serving line, then the ingredient list. */
function lowerHalf(
  items: string[],
  rows = [fact("Cinnamon (bark)", "10 mg", "*"), fact("Apple Pectin", "10 mg", "*")],
) {
  const candidate = panel(rows, null, null);
  return {
    ...candidate,
    otherIngredients: {
      heading: agreementField("Other Ingredients"),
      items: items.map(agreementField),
    },
    ingredientsComplete: true,
    formulaComplete: false,
    issues: [
      {
        code: "FORMULA_MISSING",
        detail:
          "Serving size, servings per container, and the upper portion of the formula panel are not visible.",
      },
    ],
  } as LabelImageCandidate;
}

const sevenItems = [
  "Cellulose",
  "croscarmellose sodium",
  "vegetable stearic acid",
  "vegetable magnesium stearate",
  "silica",
  "turmeric",
  "vitamin B2 (riboflavin) coating. (All from non-animal sources)",
];

function mergeOrdered(candidates: LabelImageCandidate[]) {
  const setup = assemblySetup(candidates);
  setup.join.manifest.evidencePolicy = "label-image-first/7";
  return {
    setup,
    merged: mergeLabelProduct(setup.join.manifest, { entries: [...setup.entries.values()] }),
  };
}

// B001E11AP8 (2026-10-21): image-2 shows the herbal rows and the ingredient list, image-3 the serving line and the
// vitamin rows. Before, the split compared the incomplete lower formula row by row and ended FORMULA_CONFLICT.
it("joins the lower half of a panel read before the upper half, keeping both source IDs", async () => {
  const { setup, merged } = mergeOrdered([lowerHalf(sevenItems), upperHalf()]);
  expect(merged.codes).toEqual([]);
  expect(merged.status).toBe("ready");
  expect(merged.warnings).toContainEqual({
    id: "source-0",
    code: "LABEL_PRODUCT.FORMULA_SECTIONS_JOINED",
  });
  const rows = defined(defined(merged.formula).columns[0]).rows;
  expect(rows.map((row) => row.name.text)).toEqual([
    "Vitamin A (as beta carotene)",
    "Vitamin C (as ascorbic acid)",
    "Lutein",
    "Cinnamon (bark)",
    "Apple Pectin",
  ]);
  expect(new Set(rows.map((row) => row.name.sourceId))).toEqual(new Set(["source-0", "source-1"]));
  expect(defined(merged.formula).servingSize?.sourceId).toBe("source-1");
  expect(defined(merged.otherIngredients).items).toHaveLength(7);
  const assembled = await setup.assembly.run(setup.join, signal());
  expect(assembled.status).toBe("ready");
  const collected = await setup.collector.run(
    { join: setup.join, evidenceKey: assembled.evidenceKey },
    signal(),
  );
  expect(collected).toMatchObject({ status: "collected" });
});

it("still ends FORMULA_CONFLICT when the lower half repeats a row with another dose", () => {
  const { merged } = mergeOrdered([
    lowerHalf(sevenItems, [fact("Lutein", "500 mcg", "*"), fact("Apple Pectin", "10 mg", "*")]),
    upperHalf(),
  ]);
  expect(merged.codes).toContain("LABEL_PRODUCT.FORMULA_CONFLICT");
});

// B007VN4HKI (2026-10-21): the front label repeats two doses as callouts ("RHODIOLA EXTRACT 385MG") that the Facts
// panel prints as blend components with their full names.
it("lets front-label callouts that prefix the panel's rows pass as an unselected incomplete image", () => {
  const front: LabelImageCandidate = {
    ...panel([fact("RHODIOLA EXTRACT", "385MG"), fact("BORON CITRATE", "100MG")], null, null),
    otherIngredients: null,
    ingredientsComplete: false,
    formulaComplete: false,
    issues: [
      { code: "FORMULA_MISSING", detail: "The image shows only the front label." },
      { code: "INGREDIENTS_MISSING", detail: "The Other Ingredients section is not visible." },
    ],
  };
  const facts: LabelImageCandidate = {
    ...panel(
      [
        fact("Calcium", "50mg", "4%"),
        group("Anti-Catabolic Complex"),
        component(
          "Rhodiola extract (as Rhodiola crenulata) (root) Standardized for salidrosides",
          "385mg",
          1,
        ),
        component("Ginkgo extract (as Ginkgo biloba) (leaf)", "2.8mg", 1),
        group("Free (Active) Testosterone Stimulator"),
        component("Boron citrate Supplying 5mg of boron", "100mg", 4),
      ],
      "2 Caplets",
      "30",
    ),
    otherIngredients: null,
    ingredientsComplete: false,
    issues: [{ code: "INGREDIENTS_MISSING", detail: "Other Ingredients section is not visible." }],
  };
  const { merged } = mergeOrdered([front, facts]);
  expect(merged.codes).toEqual([]);
  expect(merged.warnings).toContainEqual({
    id: "source-0",
    code: "LABEL_PRODUCT.INCOMPLETE_IMAGE_NOT_SELECTED",
  });
  expect(defined(merged.formula).servingSize?.sourceId).toBe("source-1");
  expect(defined(defined(merged.formula).columns[0]).rows).toHaveLength(6);
  const changedDose = {
    ...front,
    formula: defined(panel([fact("RHODIOLA EXTRACT", "38.5MG")], null, null).formula),
  };
  expect(mergeOrdered([changedDose, facts]).merged.codes).toContain(
    "LABEL_PRODUCT.FORMULA_CONFLICT",
  );
});

// The page lists six of the seven printed excipients: a subset, which the selection already records as a warning.
it("does not call a page list that prints fewer items than the image a partial-label conflict", () => {
  const image = lowerHalf(sevenItems);
  const page = lowerHalf(sevenItems.filter((item) => item !== "turmeric"));
  const parts = { formula: false, ingredients: true };
  expect(partialLabelConflicts(page, image, parts)).toEqual([]);
  expect(partialLabelConflicts(image, page, parts)).toEqual([]);
  const other = lowerHalf([...sevenItems.slice(0, 6), "shellac"]);
  expect(partialLabelConflicts(other, image, parts)).toEqual([
    "LABEL_PRODUCT.INGREDIENTS_CONFLICT",
  ]);
});
