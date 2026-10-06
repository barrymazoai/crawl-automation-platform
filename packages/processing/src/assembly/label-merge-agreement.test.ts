import { describe, expect, it } from "vitest";
import {
  projectLabelProductCandidate,
  type LabelImageCandidate,
} from "@crawl-automation/v3-contracts";
import { assemblySetup } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import { collectBoth, merge, mergeSetup, rowsOf, signal } from "../testing/merge-fixture.js";
import { agreementCandidate, agreementField } from "./label-agreement-fixture.js";
import { compareLabelStructure } from "./label-comparison.js";
import { mergeLabelProduct } from "./label-merge.js";

const warning = { id: "source-1", code: "LABEL_PRODUCT.SOURCE_WORDING_DIFFERS" };
const vitamin = "Vitamin D (as cholecalciferol)";
const vitaminD3 = "Vitamin D (as D3 cholecalciferol)";

function mergeImages(first: LabelImageCandidate, second: LabelImageCandidate) {
  const setup = assemblySetup([first, second]);
  setup.join.manifest.evidencePolicy = "label-image-first/1";
  return mergeLabelProduct(setup.join.manifest, { entries: [...setup.entries.values()] });
}

const compareImages = (first: LabelImageCandidate, second: LabelImageCandidate) =>
  compareLabelStructure({ kind: "image", candidate: first }, { kind: "image", candidate: second });

function expectAgreement(first: LabelImageCandidate, second: LabelImageCandidate) {
  const result = mergeImages(first, second);
  expect(result).toMatchObject({ status: "ready", codes: [], warnings: [warning] });
  expect(result.formula).toEqual(projectLabelProductCandidate("source-0", first).formula);
  expect(result.otherIngredients).toEqual(
    projectLabelProductCandidate("source-0", first).otherIngredients,
  );
  expect(result.provenance.map((source) => source.candidate)).toEqual([first, second]);
  expect(compareImages(first, second)).toEqual({ status: "match", codes: [] });
}

describe("label source wording agreement", () => {
  // Both directions cover the same wording discrepancy reported across 19 products.
  it.each([
    [vitamin, vitaminD3],
    [vitaminD3, vitamin],
  ])("keeps the first Prevagen source: %s versus %s", (first, second) =>
    expectAgreement(agreementCandidate(first), agreementCandidate(second)),
  );

  it.each([
    "Vitamin D (as D-3 cholecalciferol)",
    " VITAMIN  D (FROM D3 CHOLECALCIFEROL) ",
    "Vitamin-D (as cholecalciferol, D3)",
  ])("accepts bounded source wording: %s", (name) => {
    expectAgreement(agreementCandidate(), agreementCandidate(name));
  });

  it.each([
    ["10mg", "50 µg", "250 %"],
    ["10 MG", "50 μg", "250%"],
    ["10 milligrams", "50 micrograms", "250%"],
    ["10 mg", "50 ug", "250 %"],
  ])("accepts unit spelling and spacing (%s, %s, %s)", (dose, micrograms, dailyValue) => {
    const other = agreementCandidate();
    const rows = rowsOf(other);
    defined(rows[0]).amount = agreementField(micrograms);
    defined(rows[0]).dailyValue = agreementField(dailyValue);
    defined(rows[1]).amount = agreementField(dose);
    expectAgreement(agreementCandidate(), other);
  });

  it.each([
    "casein peptones",
    "contains 2% or less of: casein peptones",
    "contains less than 2% of: casein peptones",
    "less than 2% of: casein peptones",
    "CONTAINS 2 % OR LESS OF: casein peptones",
    "contains less of: casein peptones",
  ])("accepts ingredient case and leading qualifier (%s)", (item) => {
    expectAgreement(
      agreementCandidate(),
      agreementCandidate(vitamin, ["microcrystalline   cellulose", item]),
    );
  });

  it("accepts the annatto qualifier, including on the selected source", () => {
    expectAgreement(
      agreementCandidate(vitamin, ["contains 2% or less of: annatto extract (for color)"]),
      agreementCandidate(vitamin, ["annatto extract (for color)"]),
    );
  });

  it.each([
    ["casein", "potassium citrate"],
    ["Microcrystalline cellulose", "casein", "potassium citrate"],
    ["casein"],
    ["casein peptones", "Microcrystalline cellulose"],
    ["Microcrystalline cellulose", "casein peptones", "potassium citrate"],
    ["Microcrystalline cellulose", "contains 5% or less of: casein peptones"],
  ])("keeps real ingredient item/order differences in Review: %j", (...items) => {
    const first = agreementCandidate();
    const second = agreementCandidate(vitamin, items);
    expect(mergeImages(first, second)).toMatchObject({
      status: "review",
      codes: ["LABEL_PRODUCT.INGREDIENTS_CONFLICT"],
      warnings: [],
    });
    expect(compareImages(first, second).codes).toContain("LABEL.OTHER_INGREDIENTS_CONFLICT");
  });

  it.each([
    "Vitamin K (as cholecalciferol)",
    "Vitamin D (as ergocalciferol)",
    "Vitamin D (as D2 cholecalciferol)",
    "Vitamin D",
    "Vitamin D (as cholecalciferol) (extra)",
  ])("keeps different names or unrelated clauses in Review: %s", (name) => {
    const first = agreementCandidate(vitaminD3);
    const second = agreementCandidate(name);
    expect(mergeImages(first, second)).toMatchObject({
      status: "review",
      codes: ["LABEL_PRODUCT.FORMULA_CONFLICT"],
      warnings: [],
    });
    expect(compareImages(first, second).codes).toContain("LABEL.FORMULA_CONFLICT");
  });

  it.each(["20 mg", "10 mcg", "1 0 mg", "<10 mg", "10 mg†"])(
    "keeps different or qualified amounts in Review: %s",
    (amount) => {
      const other = agreementCandidate();
      defined(rowsOf(other)[1]).amount = agreementField(amount);
      expect(mergeImages(agreementCandidate(), other).codes).toContain(
        "LABEL_PRODUCT.FORMULA_CONFLICT",
      );
      expect(compareImages(agreementCandidate(), other).codes).toContain("LABEL.FORMULA_CONFLICT");
    },
  );

  it("keeps a real conflict when a separate section agrees after normalization", () => {
    const other = agreementCandidate(vitaminD3, ["casein", "potassium citrate"]);
    expect(mergeImages(agreementCandidate(), other)).toMatchObject({
      status: "review",
      codes: ["LABEL_PRODUCT.INGREDIENTS_CONFLICT"],
      warnings: [warning],
    });
  });

  it("does not warn for identical sources", () => {
    expect(mergeImages(agreementCandidate(), agreementCandidate())).toMatchObject({
      status: "ready",
      codes: [],
      warnings: [],
    });
  });

  it("keeps secondary text wording visible without reporting a content conflict", async () => {
    const setup = await mergeSetup([agreementCandidate()], agreementCandidate(vitaminD3));
    expect(merge(setup)).toMatchObject({
      status: "ready",
      codes: [],
      warnings: [{ id: "a-text", code: warning.code }],
    });
  });

  it("persists the warning and original values in assembly evidence", async () => {
    const setup = assemblySetup([agreementCandidate(), agreementCandidate(vitaminD3)]);
    const output = await setup.assembly.run(setup.join, signal());
    expect(output.status).toBe("ready");
    const input = { join: setup.join, evidenceKey: output.evidenceKey };
    expect((await setup.collector.run(input, signal())).status).toBe("collected");
    expect((await setup.cold().collector.run(input, signal())).status).toBe("collected");
    expect(defined([...setup.collected.values()][0]).warnings).toEqual([warning]);
  });

  it("collects image-first wording agreement through cold readback", async () => {
    const setup = await mergeSetup(
      [agreementCandidate(), agreementCandidate(vitaminD3)],
      agreementCandidate(),
    );
    await collectBoth(setup);
  });

  it.each(["Capsule", "Tablet"])(
    "collects the reported metadata differences (%s)",
    async (unit) => {
      const first = agreementCandidate();
      const second = agreementCandidate(vitaminD3);
      const firstFormula = defined(first.formula);
      const secondFormula = defined(second.formula);
      firstFormula.servingsPerContainer = null;
      secondFormula.servingsPerContainer = agreementField(`30 ${unit.toLowerCase()}s per bottle`);
      firstFormula.servingSize = agreementField(`1 ${unit}`);
      secondFormula.servingSize = agreementField(`1 ${unit.toLowerCase()}`);
      defined(firstFormula.columns[0]).heading = agreementField(`Amount Per ${unit}`);
      defined(secondFormula.columns[0]).heading = agreementField(
        `Amount per ${unit.toLowerCase()}`,
      );
      defined(rowsOf(first)[1]).dailyValue = agreementField("<1%**");
      defined(rowsOf(second)[1]).dailyValue = agreementField("<1% **");
      expectAgreement(first, second);
      expectAgreement(second, first);
      const setup = await mergeSetup([first, second], first);
      const saved = await collectBoth(setup);
      expect(saved.formula).toEqual(projectLabelProductCandidate("source-0", first).formula);
      expect(saved.formula?.servingsPerContainer).toBeNull();
      expect(saved.warnings).toContainEqual(warning);
    },
  );

  it("keeps different printed counts in Review and uses the existing diagnostic code", () => {
    const first = agreementCandidate();
    const second = agreementCandidate();
    defined(first.formula).servingsPerContainer = agreementField("30 capsules");
    defined(second.formula).servingsPerContainer = agreementField("60 capsules");
    expect(mergeImages(first, second)).toMatchObject({
      status: "review",
      codes: ["LABEL_PRODUCT.FORMULA_CONFLICT"],
      warnings: [],
    });
    expect(compareImages(first, second)).toEqual({
      status: "conflict",
      codes: ["LABEL.CONTAINER_COUNT_CONFLICT"],
    });
  });
});
