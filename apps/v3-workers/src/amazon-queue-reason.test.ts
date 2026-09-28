import { expect, it } from "vitest";
import { queueReviewReason } from "./amazon-queue-reason.js";

const field = (text: string) => ({ text, evidence: text });
const image = (name: string, amount: string | null) => ({ codec: "label-extraction/1", issues: [], exclusions: [], formulaComplete: true, ingredientsComplete: true,
  formula: { servingSize: field("2 Capsules"), servingsPerContainer: field("30"), columns: [{ heading: field("Amount Per Serving"), rows: [
    { kind: "blend_total", name: field("Blend"), amount: field("600 mg"), amountStatus: "printed", dailyValue: null, parentRowIndex: null },
    { kind: "blend_component", name: field(name), amount: amount ? field(amount) : null, amountStatus: amount ? "printed" : "not_declared", dailyValue: null, parentRowIndex: 0 }] }] },
  otherIngredients: { heading: field("Other Ingredients"), items: [field("Vegetable Cellulose")] } });

it("a capture Review says what the provider did, including the redirect target", () => {
  const r = queueReviewReason({ status: "review" }, [{ failure: { stage: "amazon.browser", code: "AMAZON.BROWSER_PHASE_UNRESOLVED" },
    rawError: { details: { causeCode: "SCRAPERAPI.REDIRECT_UNVERIFIED", causeDetails: { status: 301, location: "https://www.amazon.com/dp/B0OTHER0001" } } } }]);
  expect(r.summary).toContain("SCRAPERAPI.REDIRECT_UNVERIFIED");
  expect(r.summary).toContain("location=https://www.amazon.com/dp/B0OTHER0001");
});
it("an assembly Review names the image and the row that broke the rule", () => {
  const r = queueReviewReason({ status: "review" }, [
    { failure: { stage: "codex.vision", code: "VISION.LABEL_CORE_MISSING" }, candidate: { value: { ...image("x", "1 mg"), formula: null, otherIngredients: null, issues: [{ code: "FORMULA_MISSING", detail: "front label only" }] } } },
    { failure: { stage: "product.label.assembly", code: "LABEL.AMOUNT_EVIDENCE_CONFLICT" }, rawError: { details: { codes: ["LABEL.AMOUNT_EVIDENCE_CONFLICT"] } },
      candidate: { value: { result: { provenance: [{ id: "image-6", kind: "image", candidate: image("Turmeric Extract (Standardized to 95% Curcuminoids)", "500 mg") }] } } } }]);
  expect(r.summary.startsWith("LABEL.AMOUNT_EVIDENCE_CONFLICT")).toBe(true);
  expect(r.summary).toContain('image-6: LABEL.AMOUNT_EVIDENCE_CONFLICT row 1 "Turmeric Extract (Standardized to 95% Curcuminoids)": name quotes 95% but amount is "500 mg"');
  // The marketing image's expected "no label" comes after the deciding rule.
  expect(r.items[0]!.stage).toBe("product.label.assembly"); expect(r.items.at(-1)!.code).toBe("VISION.LABEL_CORE_MISSING");
});
it("never throws on records it does not understand", () => {
  expect(queueReviewReason(undefined, [null, 1, "x", { failure: { code: "OCR.EMPTY", stage: "ocr.file" }, inspection: { input: { file: { objectKey: 42 } } } },
    { failure: { code: "LABEL.X", stage: "product.label.assembly" }, candidate: { value: { result: { provenance: [{ kind: "image", candidate: { broken: true } }] } } } }]).summary)
    .toContain("LABEL.X");
});
it("a stopped label preparation says which step and which sources", () => {
  const r = queueReviewReason({ status: "review" }, [{ failure: { stage: "channel.label-input", code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED" },
    rawError: { details: { failures: [{ sourceId: "manifest", code: "CHANNEL.LABEL_NO_SOURCE" }], states: [{ id: "image-1", status: "unresolved" }, { id: "image-2", status: "not_matched" }] } } }]);
  expect(r.summary).toContain("manifest: CHANNEL.LABEL_NO_SOURCE"); expect(r.summary).toContain("unresolved sources: image-1 unresolved");
});
