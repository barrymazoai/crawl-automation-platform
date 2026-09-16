import { expect, it } from "vitest";
import { LabelTextWireSchema, labelFormulaStructure } from "@crawl-automation/v3-contracts";
import { gncLabelFixture } from "../../v3-contracts/src/label.fixture.js";
import { decodeLabelText, labelTextPrompt } from "./label-extraction.js";

function fixture() {
  const image = gncLabelFixture(), lines: string[] = [];
  const anchor = (f: { text: string }) => { lines.push(f.text); return { fromLine: lines.length, toLine: lines.length, text: f.text }; };
  const optional = (f: { text: string } | null) => f ? anchor(f) : null;
  const formula = image.formula!;
  const wire = LabelTextWireSchema.parse({ ...image,
    formula: { servingSize: optional(formula.servingSize), servingsPerContainer: optional(formula.servingsPerContainer),
      columns: formula.columns.map(c => ({ heading: optional(c.heading), rows: c.rows.map(r => ({ ...r,
        name: anchor(r.name), amount: optional(r.amount), dailyValue: optional(r.dailyValue) })) })) },
    otherIngredients: { heading: anchor(image.otherIngredients!.heading), items: image.otherIngredients!.items.map((item, i) => {
      if (i) lines.push(","); return anchor(item);
    }) },
  });
  return { image, wire, lines, decode() { const text = lines.join("\n"); return decodeLabelText({ range: { start: 0, end: text.length } }, text, JSON.stringify(wire)); } };
}
it("text and image share all rows, own doses and duplicate-name group identities; no colon is required", () => {
  const f = fixture(), result = f.decode();
  expect(result.status).toBe("candidate");
  expect(labelFormulaStructure(result.candidate)).toEqual(labelFormulaStructure(f.image));
  expect(result.candidate.formula!.columns[0]!.rows[5]!.amount!.text).toBe("200 mg");
  const text = f.lines.join("\n"), q = result.candidate.formula!.columns[0]!.rows[14]!.name;
  expect(text.slice(q.start, q.end)).toBe(q.text);
});
it("a visible component dose cannot be omitted even when represented as an undisclosed total-blend component", () => {
  const f = fixture(), rows = f.wire.formula!.columns[0]!.rows;
  rows[5]!.amount = null; rows[5]!.amountStatus = "not_declared";
  expect(f.decode().codes).toContain("LABEL.EXTRACTION_INCOMPLETE");
});
it("explicit model issues and metadata exclusions never silently resolve 3 versus 12", () => {
  const f = fixture(); f.lines.push("Servings Per Container 12");
  f.wire.exclusions.push({ reason: "metadata", quote: { fromLine: f.lines.length, toLine: f.lines.length, text: "Servings Per Container 12" } });
  f.wire.issues.push({ code: "METADATA_CONFLICT", detail: "3 versus 12" });
  expect(f.decode().codes).toEqual(expect.arrayContaining(["LABEL.COVERAGE_UNCERTAIN", "LABEL.EVIDENCE_UNCERTAIN"]));
});
it.each(["marketing", "noise", "heading"] as const)("an omitted component dose cannot be laundered as %s", reason => {
  const f = fixture(), row = f.wire.formula!.columns[0]!.rows[5]!;
  f.wire.exclusions.push({ reason, quote: row.amount! }); row.amount = null; row.amountStatus = "unreadable";
  expect(f.decode().codes).toContain("LABEL.COVERAGE_UNCERTAIN");
});
it("ingredient-heading words inside prose are not a real section", () => {
  const f = fixture(), a = f.wire.otherIngredients!.heading; f.lines[a.fromLine - 1] = "We discuss Other Ingredients";
  expect(f.decode().codes).toContain("LABEL.INGREDIENT_HEADING_INVALID");
});
it("a heading that opens a new clause on a shared line is a real section", () => {
  const f = fixture(), a = f.wire.otherIngredients!.heading; f.lines[a.fromLine - 1] = "Vitamin D. " + f.lines[a.fromLine - 1];
  expect(f.decode().codes).not.toContain("LABEL.INGREDIENT_HEADING_INVALID");
  f.lines[a.fromLine - 1] = "Vitamin D 25 mcg 125% " + a.text;
  expect(f.decode().codes).not.toContain("LABEL.INGREDIENT_HEADING_INVALID");
});
it("Contains is not an ingredient and a line wrap is not a delimiter", () => {
  const f = fixture(), items = f.wire.otherIngredients!.items;
  f.lines[items[1]!.fromLine - 2] = "CONTAINS: ";
  expect(f.decode().codes).toContain("LABEL.INGREDIENT_ROLE_INVALID");
  f.lines[items[1]!.fromLine - 2] = "";
  expect(f.decode().codes).toContain("LABEL.INGREDIENT_BOUNDARY");
});
it("a forged exact quote or reordered formula is rejected", () => {
  const f = fixture(), rows = f.wire.formula!.columns[0]!.rows;
  rows[5]!.amount!.text = "999 mg"; expect(() => f.decode()).toThrow("TEXT.CITATION_INVALID");
  rows[5]!.amount!.text = "200 mg"; [rows[5], rows[6]] = [rows[6]!, rows[5]!];
  expect(f.decode().codes).toContain("LABEL.ROW_ORDER_INVALID");
});
it("prompt keeps component amounts, own-column indices and metadata conflicts explicit", () => {
  const p = labelTextPrompt({ range: { start: 0, end: 1 } }, "x");
  expect(p).toContain("SAME ROW"); expect(p).toContain("parentRowIndex"); expect(p).toContain("METADATA_CONFLICT");
});
it("serving metadata keeps the exact value while harmless heading prefixes are accounted for", () => {
  const f = fixture(); f.lines[0] = "Serving Size: 2"; f.lines[1] = "Servings Per Container: 3";
  f.wire.exclusions.push({ reason: "heading", quote: { fromLine: 1, toLine: 1, text: "Serving Size:" } },
    { reason: "heading", quote: { fromLine: 2, toLine: 2, text: "Servings Per Container:" } });
  const result = f.decode(); expect(result.status).toBe("candidate");
  expect(result.candidate.formula!.servingSize!.text).toBe("2");
});

function blendFixture() {
  const lines=["Select Tocotrienols Blend","125 mg","consisting of","90% delta tocotrienol","and","10% gamma tocotrienol","Other Ingredients:","Gelatin, water","1 Softgel"];
  const a=(line:number,text=lines[line-1]!)=>({fromLine:line,toLine:line,text});
  const wire=LabelTextWireSchema.parse({codec:"label-extraction/1",formulaComplete:true,ingredientsComplete:true,issues:[],
    formula:{servingSize:a(9),servingsPerContainer:null,columns:[{heading:null,rows:[
      {kind:"blend_total",name:a(1),amount:a(2),dailyValue:null,amountStatus:"printed",parentRowIndex:null},
      {kind:"blend_component",name:a(4,"delta tocotrienol"),amount:a(4,"90%"),dailyValue:null,amountStatus:"printed",parentRowIndex:0},
      {kind:"blend_component",name:a(6,"gamma tocotrienol"),amount:a(6,"10%"),dailyValue:null,amountStatus:"printed",parentRowIndex:0}]}]},
    otherIngredients:{heading:a(7),items:[a(8,"Gelatin"),a(8,"water")]},
    exclusions:[{reason:"noise",quote:a(3)},{reason:"noise",quote:a(5)}]});
  const text=lines.join("\n");return{wire,decode:(version="label-text/3")=>decodeLabelText({range:{start:0,end:text.length}},text,JSON.stringify(wire),version)};
}
it("v3 retains one dosed blend and its percentage components; v2 still rejects linking noise",()=>{
  const f=blendFixture();expect(f.decode().status).toBe("candidate");expect(f.decode("label-text/2").codes).toContain("LABEL.COVERAGE_UNCERTAIN");
  expect(f.decode().candidate.formula!.columns[0]!.rows).toHaveLength(3);
  const scope={range:{start:0,end:1}};
  expect(labelTextPrompt(scope,"x","label-text/2")).not.toContain("ONE blend_total row");
  expect(labelTextPrompt(scope,"x","label-text/3")).toContain("ONE blend_total row");
});
it("v3 cannot hide a printed dose or turn a duplicated blend into a valid group",()=>{
  const f=blendFixture(),rows=f.wire.formula!.columns[0]!.rows;
  f.wire.exclusions.push({reason:"noise",quote:rows[0]!.amount!});rows[0]!.amount=null;rows[0]!.amountStatus="unreadable";
  expect(f.decode().codes).toContain("LABEL.COVERAGE_UNCERTAIN");
  const g=blendFixture(),r=g.wire.formula!.columns[0]!.rows;
  r.unshift({...r[0]!,kind:"group_header",amount:null,amountStatus:"not_applicable"});
  expect(g.decode().codes).toContain("LABEL.ROW_ORDER_INVALID");expect(g.decode().status).toBe("review");
});
it("v4 accepts only exact serving-heading metadata, duplicate ingredient heading and singular DV footnote",()=>{
 const f=fixture();f.lines[0]="Serving Size 2";f.wire.exclusions.push({reason:"metadata",quote:{fromLine:1,toLine:1,text:"Serving Size"}},
  {reason:"heading",quote:f.wire.otherIngredients!.heading});
 f.lines.push("† Percent Daily Value (DV) not established.");f.wire.exclusions.push({reason:"footnote",quote:{fromLine:f.lines.length,toLine:f.lines.length,text:f.lines.at(-1)!}});
 const text=f.lines.join("\n"),scope={range:{start:0,end:text.length}},raw=JSON.stringify(f.wire);
 expect(decodeLabelText(scope,text,raw,"label-text/3").status).toBe("review");
 expect(decodeLabelText(scope,text,raw,"label-text/4").status).toBe("candidate");
 f.wire.exclusions.push({reason:"metadata",quote:f.wire.formula!.columns[0]!.rows[5]!.amount!});
 expect(decodeLabelText(scope,text,JSON.stringify(f.wire),"label-text/4").codes).toContain("LABEL.COVERAGE_UNCERTAIN");
});
