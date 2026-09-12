import { expect, it } from "vitest";
import { gncLabelFixture } from "../../v3-contracts/src/label.fixture.js";
import { decodeLabelImage, decodeLabelImageV2, labelVisionOutputSchema, labelVisionPrompt, labelVisionPolicyVersion } from "./label-extraction.js";
import {splitLabelIngredients} from "@crawl-automation/v3-contracts";
import { candidate as legacy } from "./testing.fixture.js";
it("explicit typed headings do not produce the legacy false core-missing error", () => {
  expect(decodeLabelImage(JSON.stringify(gncLabelFixture()))).toMatchObject({ status: "candidate", codes: [] });
});
it("missing readable doses still fail and original metadata remains intact", () => {
  const c = gncLabelFixture(); c.formula!.columns[0]!.rows[14]!.amount = null;
  const result = decodeLabelImage(JSON.stringify(c));
  expect(result.status).toBe("review"); expect(result.candidate.formula!.servingsPerContainer!.text).toBe("3");
});
it("legacy raw responses are not silently relabelled and model schema remains strict", () => {
  expect(() => decodeLabelImage(JSON.stringify(legacy))).toThrow();
  expect(JSON.stringify(labelVisionOutputSchema)).toContain('"additionalProperties":false');
});
it("versioned prompt preserves parenthesized continuation and one dosed blend",()=>{
  expect(labelVisionPolicyVersion).toBe("label-vision/5");
  expect(labelVisionPrompt).toContain("never a standalone '(capsule)' item");
  expect(labelVisionPrompt).toContain("not one item per printed line");
  expect(labelVisionPrompt).toContain("ONE blend_total row");
});
it("v2 derives three ingredients from original transcription, not the model's split array",()=>{
  const c=gncLabelFixture();c.otherIngredients!.items=[{text:"(capsule)",evidence:"(capsule)"}];
  const text="BSE-free gelatin (capsule), vegetable glycerine, double-distilled and deionized water";
  const raw=JSON.stringify({codec:"label-visual-wire/2",label:c,otherIngredientsBlock:{text,evidence:text}});
  const decoded=decodeLabelImageV2(raw);expect(decoded.status).toBe("candidate");expect(decoded.candidate.otherIngredients!.items.map(i=>i.text)).toEqual(text.split(", "));
  expect(()=>decodeLabelImage(raw)).toThrow();
});
it("top-level splitting preserves nested ingredients and visual wraps",()=>{
  expect(splitLabelIngredients("gelatin\n(capsule), coating (water, starch [corn, rice]); double-distilled and deionized water")).toEqual(["gelatin\n(capsule)","coating (water, starch [corn, rice])","double-distilled and deionized water"]);
});
it.each(["a (b], c","a,","a,,b","(capsule), water","Other Ingredients: a,b"])("ambiguous ingredient boundary is rejected: %s",s=>expect(()=>splitLabelIngredients(s)).toThrow());
it("v2 rejects missing or contradictory full transcription instead of inventing ingredients",()=>{
  const c=gncLabelFixture();for(const block of [null,{text:"water",evidence:"oil"}])expect(decodeLabelImageV2(JSON.stringify({codec:"label-visual-wire/2",label:c,otherIngredientsBlock:block})).codes).toContain("LABEL.INGREDIENT_BOUNDARY");
});
it("v2 rejects a printed component proportion lost from amount, legacy remains readable",()=>{
  const c=gncLabelFixture();const rows=c.formula!.columns[0]!.rows,parent=rows[4]!;parent.kind="blend_total";parent.amount={text:"100 mg",evidence:"100 mg"};parent.amountStatus="printed";const component=rows[5]!;
  component.name.evidence="90% "+component.name.text;component.amount=null;component.amountStatus="not_declared";
  const text=c.otherIngredients!.items.map(i=>i.text).join(", ");
  expect(decodeLabelImageV2(JSON.stringify({codec:"label-visual-wire/2",label:c,otherIngredientsBlock:{text,evidence:text}})).codes).toContain("LABEL.AMOUNT_EVIDENCE_CONFLICT");
  expect(decodeLabelImage(JSON.stringify(c)).codes).not.toContain("LABEL.AMOUNT_EVIDENCE_CONFLICT");
});
