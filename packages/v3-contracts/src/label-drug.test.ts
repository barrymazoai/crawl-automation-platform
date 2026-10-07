import { describe, expect, it } from "vitest";
import { LabelImageCandidateSchema, assessLabelCandidate, labelFormulaStructure } from "./label-extraction.js";
import { formulaAgreement } from "./label-agreement.js";
import { gncLabelFixture } from "./label.fixture.js";
import { projectLabelProductCandidate } from "./label-product.js";

const field = (text: string) => ({ text, evidence: text });
function drugCandidate() {
  const candidate = gncLabelFixture();
  candidate.formula = { drugFacts: field("Drug Facts"), servingSize: null, servingsPerContainer: null,
    columns: [{ heading: field("Active ingredient"), rows: [{ kind: "nutrient",
      name: field("Arnica montana"), amount: field("30C HPUS"), purpose: field("Relieves pain"),
      dailyValue: null, amountStatus: "printed", parentRowIndex: null }] }] };
  candidate.otherIngredients = { heading: field("Inactive ingredients"), items: [field("lactose")] };
  return LabelImageCandidateSchema.parse(candidate);
}

describe("backward-compatible Drug Facts contracts", () => {
  it("Drug Facts needs no serving metadata; a supplement without one keeps its formula with a warning", () => {
    expect(assessLabelCandidate(drugCandidate()).status).toBe("candidate");
    expect(assessLabelCandidate(drugCandidate()).warnings.map((w) => w.code)).not.toContain("LABEL.SERVING_SIZE_MISSING");
    const supplement = gncLabelFixture();
    supplement.formula!.servingSize = null;
    const assessed = assessLabelCandidate(supplement);
    expect(assessed.codes).not.toContain("LABEL.FORMULA_INCOMPLETE");
    expect(assessed.warnings.map((w) => w.code)).toContain("LABEL.SERVING_SIZE_MISSING");
  });
  it("treats an absent and null Purpose identically on existing supplement rows", () => {
    const first = gncLabelFixture();
    const second = gncLabelFixture();
    second.formula!.columns[0]!.rows[0]!.purpose = null;
    expect(formulaAgreement(first.formula, second.formula)).toBe("exact");
    expect(labelFormulaStructure(first)).toEqual(labelFormulaStructure(second));
  });
  it("rejects a false heading or a missing active strength", () => {
    const candidate = drugCandidate();
    candidate.formula!.drugFacts = field("Supplement Facts");
    expect(assessLabelCandidate(candidate).codes).toContain("LABEL.FORMULA_INCOMPLETE");
    candidate.formula!.drugFacts = field("Drug Facts");
    candidate.formula!.columns[0]!.rows[0]!.amount = null;
    candidate.formula!.columns[0]!.rows[0]!.amountStatus = "not_declared";
    expect(assessLabelCandidate(candidate).codes).toContain("LABEL.AMOUNT_MISSING");
  });
  it("projects the discriminator and Purpose with their source citations", () => {
    const projected = projectLabelProductCandidate("drug-source", drugCandidate());
    expect(projected.formula?.drugFacts).toEqual({ text: "Drug Facts", sourceId: "drug-source",
      citation: { kind: "image", evidence: "Drug Facts" } });
    expect(projected.formula?.columns[0]?.rows[0]?.purpose).toEqual({ text: "Relieves pain",
      sourceId: "drug-source", citation: { kind: "image", evidence: "Relieves pain" } });
  });
  it("compares Purpose and panel type instead of dropping them from agreement", () => {
    const first = drugCandidate();
    const second = drugCandidate();
    second.formula!.columns[0]!.rows[0]!.purpose = field("Relieves itching");
    expect(formulaAgreement(labelFormulaStructure(first), labelFormulaStructure(second))).toBe("conflict");
    second.formula!.columns[0]!.rows[0]!.purpose = field("Relieves pain");
    delete second.formula!.drugFacts;
    expect(formulaAgreement(labelFormulaStructure(first), labelFormulaStructure(second))).toBe("conflict");
  });
});
