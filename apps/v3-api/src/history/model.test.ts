import { describe, expect, it } from "vitest";
import { convertHistoryInput, convertLegacyProduct, identifyListing, timestamp, type LegacyProduct } from "./model.js";
const sample = (): LegacyProduct => ({ codec: "legacy-product/1", dataset: "test:legacy", kind: "product", product: {id:"p1"},
  listings:[{row:{id:"l1",channel:"amazon",external_id:"B000G01A12",original_product_url:"https://www.amazon.com/dp/B000G01A12"},
    snapshots:[{id:"s1",captured_at:"2026-08-01T10:00:00Z",price:"19.95",currency:"USD",source:"crawl:old"}]}],
  images:[],ingredients:[],formulas:[],formulaObservations:[] });
describe("legacy history conversion",()=>{
  it("keeps the raw source losslessly and preserves the observation date independently of import",()=>{
    const input=sample(),r=convertLegacyProduct(input);expect(r.raw).toEqual(input);
    expect(r.observations[0]!.observedAt).toBe("2026-08-01T10:00:00.000Z");
    expect(r.observations[0]!.record.price).toBe("19.95");expect(r.issues).toContain("HISTORY.FORMULA_ROWS_MISSING");
    expect(convertLegacyProduct(structuredClone(input))).toEqual(r);
  });
  it("deduplicates the same market ASIN across copies without losing distinct times",()=>{
    const a=sample(),b=sample();b.dataset="another-copy";b.product.id="other-product-id";
    const x=convertLegacyProduct(a),y=convertLegacyProduct(b);expect(x.id).not.toBe(y.id);
    expect(x.listings[0]!.id).toBe(y.listings[0]!.id);expect(x.observations[0]!.id).toBe(y.observations[0]!.id);
    b.listings[0]!.snapshots[0]!.captured_at="2026-09-13T10:00:00Z";
    expect(convertLegacyProduct(b).observations[0]!.id).not.toBe(x.observations[0]!.id);
  });
  it("does not treat created_at as a capture date or missing values as zero",()=>{
    const a=sample();a.listings[0]!.snapshots=[{id:"s2",created_at:"2026-08-01T10:00:00Z"}];
    const r=convertLegacyProduct(a);expect(r.observations[0]!.observedAt).toBeNull();
    expect(r.observations[0]!.record.price).toBeNull();expect(timestamp("2026-08-01")).toBeNull();
  });
  it("isolates foreign URLs, ASIN conflicts, markets and DTC variants",()=>{
    const row=sample().listings[0]!.row;
    expect(identifyListing({...row,original_product_url:"https://example.org/dp/B000G01A12"},"a","p").basis).toBe("unresolved");
    expect(identifyListing({...row,external_id:"B000G01A13"},"a","p").basis).toBe("unresolved");
    expect(identifyListing({...row,original_product_url:"https://amazon.ca/dp/B000G01A12"},"a","p").id).not.toBe(identifyListing(row,"a","p").id);
    const a=identifyListing({channel:"dtc",product_url:"https://brand.test/products/one?variant=1"},"a","p");
    const b=identifyListing({channel:"dtc",product_url:"https://brand.test/products/one?variant=2"},"a","p");expect(a.id).not.toBe(b.id);
  });
  it("uses the original URL when the legacy normalization key has no protocol",()=>{
    const row={...sample().listings[0]!.row,url_normalized:"amazon.com/dp/b000g01a12"};
    expect(identifyListing(row,"a","p").basis).toBe("external-id");
    expect(identifyListing(row,"a","p").externalId).toBe("B000G01A12");
  });
  it("keeps formula observations separate and never requires a company",()=>{
    const a=sample();a.formulas=[{row:{id:"f1"},rows:[{amount_value:"10",amount_unit:"mg",raw_text:"Zinc"}]}];
    a.formulaObservations=[{id:"fo1",listing_id:"l1",formula_id:"f1",observed_at:"2026-08-01T10:01:00Z"}];
    const r=convertLegacyProduct(a);expect(r.observations.map(x=>x.kind)).toEqual(["metrics","formula"]);
    expect(r.observations[1]!.record.confidence).toBeNull();
  });
  it("retains the already parsed formula and metrics in the no-company store",()=>{
    const a:LegacyProduct={codec:"legacy-product/1",dataset:"no-company",kind:"no-company",product:{channel:"gnc",external_id:"123456",captured_at:"2026-09-01T00:00:00Z",price:"19.90",
      raw_json:JSON.stringify({currency:null,rating:4.5,reviewCount:10,inStock:true}),
      facts_json:JSON.stringify({facts:{capturedAt:"2026-09-01T00:00:00Z",rows:[{name:"Zinc",amountValue:10,amountUnit:"mg"}]}})},
      listings:[{row:{channel:"gnc",external_id:"123456",product_url:"https://gnc.com/vitamins/123456.html"},snapshots:[]}],images:[],ingredients:[],formulas:[],formulaObservations:[]};
    const r=convertLegacyProduct(a);expect(r.observations).toHaveLength(2);
    expect(r.observations[0]!.record).toMatchObject({price:"19.90",rating:"4.5",reviewCount:"10",inStock:true,currency:null});
    expect(r.observations[1]!.record.codec).toBe("legacy-facts/1");expect(r.issues).toEqual([]);
  });
  it("does not rebind a formula whose explicit listing belongs elsewhere",()=>{
    const a=sample();a.formulas=[{row:{id:"f1"},rows:[{name:"Zinc"}]}];
    a.formulaObservations=[{listing_id:"different-listing",formula_id:"f1",observed_at:"2026-08-01T10:00:00Z"}];
    const r=convertLegacyProduct(a);expect(r.issues).toContain("HISTORY.FORMULA_LISTING_UNRESOLVED");
    expect(r.observations.every(x=>x.kind==="metrics")).toBe(true);
  });
  it("accepts a new page observation without a formula and fixes its identity independently of content",()=>{
    const a={codec:"page-observation/1",dataset:"v3:test",observationId:"capture-one",capturedAt:"2026-09-13T00:00:00Z",
      listing:{channel:"amazon",url:"https://amazon.com/dp/B000G01A12",externalId:"B000G01A12"},
      metrics:{price:"12.95",currency:"USD",listPrice:null,rating:null,reviewCount:null,salesRank:null,inStock:true,unitsSold:null,unitsSoldPeriod:null,extras:null},
      evidence:[{objectKey:"v3/test/capture.json",sha256:"a".repeat(64)}],capture:{labelOutcome:"pending"}};
    const first=convertHistoryInput(a),changed=convertHistoryInput({...a,metrics:{...a.metrics,price:"11.95"}});
    expect(first.observations[0]!.kind).toBe("metrics");expect(first.id).toBe(changed.id);
    expect(first.bodyHash).not.toBe(changed.bodyHash);expect(first.listings[0]!.id).toBe(convertLegacyProduct(sample()).listings[0]!.id);
    expect(convertHistoryInput({...a,observationId:"capture-two"}).id).not.toBe(first.id);
  });
});
