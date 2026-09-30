import { expect, it } from "vitest";
import { convertLegacyProduct, type LegacyProduct } from "./model.js";
import { productServiceMaterial } from "./product-service.js";
const sample = (): LegacyProduct => ({codec:"legacy-product/1",dataset:"older",kind:"product",product:{id:"one",name:"One product"},
  listings:[{row:{id:"l1",channel:"swanson",external_id:"ACG002",original_product_url:"https://swansonvitamins.com/p/one"},snapshots:[
    {id:"s1",captured_at:"2026-08-01T00:00:00Z",price:"12.340",currency:"USD",review_count:"9007199254740993"},
    {id:"s2",captured_at:"2026-09-01T00:00:00Z",price:"13.00",currency:null}]}],images:[],ingredients:[],formulas:[],formulaObservations:[]});
it("exports distinct historical runs without inventing company, currency or unsafe integers",()=>{
  const value=convertLegacyProduct(sample()),output=productServiceMaterial(value);
  expect(output.metrics).toHaveLength(2);
  const a=output.metrics[0] as any,b=output.metrics[1] as any;
  expect(a.run.scope).toBe("partial");expect(a.run.runId).not.toBe(b.run.runId);
  expect(a.items[0]).toMatchObject({price:"12.340",externalId:"ACG002",capturedAt:"2026-08-01T00:00:00.000Z"});
  expect(a.items[0]).not.toHaveProperty("domain");expect(a.items[0]).not.toHaveProperty("reviewCount");expect(b.items[0]).not.toHaveProperty("currency");
  expect(a.items[0].extras.retainedMetrics.reviewCount).toBe("9007199254740993");
  expect(output.retained.raw).toEqual(value.raw);expect(output.companyResolution).toBe("deferred");
});
it("keeps undated and untitled sources intact without generating fake current trend points",()=>{
  const raw=sample();raw.listings[0]!.snapshots[0]!.captured_at=null;delete raw.product.name;
  const value=convertLegacyProduct(raw),output=productServiceMaterial(value);
  expect(output.metrics).toEqual([]);expect(output.pending).toHaveLength(2);expect(output.retained.observations).toEqual(value.observations);
});
it("preserves original legacy formulas instead of relabelling them as new OCR results",()=>{
  const raw=sample();raw.formulas=[{row:{id:"f1"},rows:[{raw_text:"Zinc",amount_value:"10"}]}];
  raw.formulaObservations=[{id:"fo1",formula_id:"f1",listing_id:"l1",observed_at:"2026-08-01T00:00:00Z"}];
  const value=convertLegacyProduct(raw),output=productServiceMaterial(value);
  expect(output.labels).toEqual([]);expect(output.pending).toContain("legacy-formula:retained-with-original-schema");
  expect(output.retained.raw).toEqual(raw);
});
