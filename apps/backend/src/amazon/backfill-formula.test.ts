import { describe, expect, it } from "vitest";
import type { AmazonImageEvidence } from "./backfill-image.js";
import { buildAmazonFormulaPrompt, buildAmazonFormulaProposal } from "./backfill-formula.js";

const evidence: AmazonImageEvidence = {
  productId: "product-1",
  totalImages: 4,
  ocrSucceeded: 4,
  ocrFailed: 0,
  factsCandidates: [{
    imageId: "image-secret-id",
    imageUrl: "https://example.com/private/facts.jpg?token=secret",
    imageIndex: 3,
    response: { text: "Supplement Facts\nServing Size 1 Capsule\nVitamin C 500 mg" },
  }],
  failures: [],
};

describe("Amazon Formula OCR-text lane", () => {
  it("sends OCR text and original gallery index without URLs or image identifiers", () => {
    const prompt = buildAmazonFormulaPrompt(evidence);
    expect(prompt).toContain("IMAGE_INDEX=3");
    expect(prompt).toContain("Vitamin C 500 mg");
    expect(prompt).not.toContain("example.com");
    expect(prompt).not.toContain("token=secret");
    expect(prompt).not.toContain("image-secret-id");
  });

  it("maps a valid verdict back to the exact source candidate", () => {
    const proposal = buildAmazonFormulaProposal(evidence, {
      raw: "{}",
      parsed: {
        panelType: "supplement_facts",
        factsImages: [3],
        servingSize: "1 Capsule",
        servingsPerContainer: "60",
        activeIngredients: [{ raw: "Vitamin C", amount: "500 mg", dv: "556%" }],
        otherIngredients: [],
        unreadable: [],
      },
    });
    expect(proposal).toMatchObject({
      status: "ready",
      confidence: 100,
      sourceImages: [{ imageId: "image-secret-id", imageIndex: 3 }],
      servingSize: 1,
      servingUnit: "Capsule",
    });
    expect(proposal.rows).toHaveLength(1);
  });

  it("routes ambiguous and unreadable outcomes to review", () => {
    expect(buildAmazonFormulaProposal(evidence, {
      raw: "{}",
      parsed: { ambiguous: true, reason: "two panels" },
    }).reviewReasons).toContain("multiple_formulas_ambiguous");

    expect(buildAmazonFormulaProposal(evidence, {
      raw: "{}",
      parsed: {
        panelType: "supplement_facts",
        factsImages: [3],
        servingSize: "1 Capsule",
        activeIngredients: [{ raw: "Vitamin C", amount: "500 mg" }],
        unreadable: ["DV column"],
      },
    }).reviewReasons).toContain("facts_panel_has_unreadable_content");
  });
});
