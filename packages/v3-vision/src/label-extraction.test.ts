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
  expect(labelVisionPolicyVersion).toBe("label-vision/7");
  expect(labelVisionPrompt).toContain("never a standalone '(capsule)' item");
  expect(labelVisionPrompt).toContain("not one item per printed line");
  expect(labelVisionPrompt).toContain("ONE blend_total row");
});
function redundantDailyValueHeader(){
 const c=gncLabelFixture(),f=(text:string)=>({text,evidence:text});
 c.formula!.columns[0]!.rows[1]!.dailyValue=f("1%");
 c.formula!.columns.push({heading:f("% Daily Value"),rows:[{kind:"group_header",name:f("% Daily Value"),amount:null,dailyValue:null,amountStatus:"not_applicable",parentRowIndex:null}]});
 return c;
}
it("retains an exact data-free DV table heading without changing any actual dose or ingredient",()=>{
 const c=redundantDailyValueHeader(),raw=JSON.stringify(c),decoded=decodeLabelImage(raw);
 expect(decoded.status).toBe("candidate");expect(decoded.candidate.formula!.columns).toEqual([c.formula!.columns[0]]);
 expect(decoded.candidate.otherIngredients).toEqual(c.otherIngredients);
 expect(decoded.candidate.exclusions).toContainEqual({reason:"heading",quote:{text:"% Daily Value",evidence:"% Daily Value"}});
 expect(JSON.stringify(c)).toBe(raw);
});
it.each(["amount","dailyValue","extraRow","citation","parent","otherHeading","missingPercent","multipleDoseBases"])("does not fold an uncertain or data-bearing DV column: %s",kind=>{
 const c=redundantDailyValueHeader(),columns=c.formula!.columns,row=columns[1]!.rows[0]!,f=(text:string)=>({text,evidence:text});
 if(kind==="amount"){row.amount=f("1 mg");row.amountStatus="printed";}
 if(kind==="dailyValue")row.dailyValue=f("2%");
 if(kind==="extraRow")columns[1]!.rows.push(structuredClone(columns[0]!.rows[0]!));
 if(kind==="citation")row.name.evidence="% Daily Value 44%";
 if(kind==="parent")row.parentRowIndex=0;
 if(kind==="otherHeading")columns[1]!.heading=f("Per 2 capsules");
 if(kind==="missingPercent")columns[0]!.rows.forEach(r=>r.dailyValue=null);
 if(kind==="multipleDoseBases")columns.push(structuredClone(columns[0]!));
 expect(decodeLabelImage(JSON.stringify(c)).candidate.formula!.columns).toEqual(columns);
});
it("v2 preserves the same DV heading and still derives the ingredient list from transcription",()=>{
 const c=redundantDailyValueHeader(),text=c.otherIngredients!.items.map(i=>i.text).join(", ");
 const result=decodeLabelImageV2(JSON.stringify({codec:"label-visual-wire/2",label:c,otherIngredientsBlock:{text,evidence:text}}));
 expect(result.status).toBe("candidate");expect(result.candidate.formula!.columns).toHaveLength(1);expect(result.candidate.otherIngredients).toEqual(c.otherIngredients);
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
