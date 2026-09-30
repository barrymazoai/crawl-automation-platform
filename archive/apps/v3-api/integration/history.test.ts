import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { convertHistoryInput, convertLegacyProduct, type LegacyProduct } from "../src/history/model.js";
import { ProductHistory } from "../src/history/store.js";

const address=process.env.V3_HISTORY_TEST_URL;
describe.skipIf(!address)("history isolated PostgreSQL",()=>{
  let db:pg.Client,store:ProductHistory;
  beforeAll(async()=>{
    db=new pg.Client({connectionString:address!});await db.connect();
    const name=(await db.query("SELECT current_database() name")).rows[0].name;
    if(name!=="crawler_v3_test"||process.env.V3_HISTORY_ISOLATED!=="true")throw Error("Dedicated Mini test database required");
    if((await db.query("SELECT to_regclass('public.product_history_source') t")).rows[0].t)throw Error("Test target is not empty");
    await db.query(await readFile(new URL("../../../database/v3/018_product_history.sql",import.meta.url),"utf8"));
    await db.query(await readFile(new URL("../../../database/v3/019_history_provenance_index.sql",import.meta.url),"utf8"));
    store=new ProductHistory(db);
  });
  afterAll(async()=>{await db?.end();});
  it("appends, verifies, deduplicates, preserves partial observations and forbids history edits",async()=>{
    const input:LegacyProduct={codec:"legacy-product/1",dataset:"synthetic-test",kind:"product",product:{id:"p1"},
      listings:[{row:{id:"l1",channel:"amazon",external_id:"B000G01A12",original_product_url:"https://amazon.com/dp/B000G01A12"},snapshots:[{id:"s1",captured_at:"2026-08-01T00:00:00Z",price:"12.95",currency:"USD"}]}],
      images:[],ingredients:[],formulas:[],formulaObservations:[]};
    const first=convertLegacyProduct(input);expect(await store.append(first)).toEqual({inserted:true});
    expect(await store.append(first)).toEqual({inserted:false});
    const next=structuredClone(input);next.listings[0]!.snapshots[0]!.captured_at="2026-09-13T00:00:00Z";
    next.listings[0]!.snapshots[0]!.price="10.95";await store.append(convertLegacyProduct(next));
    expect((await db.query("SELECT record->>'price' price FROM product_history_observation ORDER BY observed_at")).rows).toEqual([{price:"12.95"},{price:"10.95"}]);
    expect((await db.query("SELECT count(*)::int n FROM product_history_listing")).rows[0].n).toBe(1);
    expect((await db.query("SELECT record FROM product_history_source WHERE source_record_id=$1",[first.id])).rows[0].record).toEqual(input);
    await expect(db.query("UPDATE product_history_observation SET observed_at=now()")).rejects.toThrow("History is append-only");
    await expect(db.query("DELETE FROM product_history_source")).rejects.toThrow("History is append-only");
    const before=(await db.query("SELECT count(*)::int n FROM product_history_source")).rows[0].n;
    const bad=convertLegacyProduct({...input,dataset:"rollback-test"});bad.listings[0]!.id="bad-id";
    await expect(store.append(bad)).rejects.toThrow();
    expect((await db.query("SELECT count(*)::int n FROM product_history_source")).rows[0].n).toBe(before);
  });
  it("stores a fresh metric observation without waiting for a label and rejects changed bodies",async()=>{
    const page={codec:"page-observation/1",dataset:"v3-test",observationId:"new-capture",capturedAt:"2026-09-13T01:00:00Z",
      listing:{channel:"amazon",url:"https://amazon.com/dp/B000G01A12",externalId:"B000G01A12"},
      metrics:{price:"9.95",currency:"USD",listPrice:null,rating:null,reviewCount:null,salesRank:null,inStock:true,unitsSold:null,unitsSoldPeriod:null,extras:null},
      evidence:[{objectKey:"test/capture.json",sha256:"a".repeat(64)}],capture:{labelOutcome:"pending"}};
    const input=convertHistoryInput(page);expect(await store.append(input)).toEqual({inserted:true});
    expect(await store.append(input)).toEqual({inserted:false});
    await expect(store.append(convertHistoryInput({...page,metrics:{...page.metrics,price:"8.95"}}))).rejects.toThrow("HISTORY.CONTENT_CONFLICT");
    expect((await db.query("SELECT record->>'price' price FROM product_history_observation WHERE observation_id=$1",[input.observations[0]!.id])).rows).toEqual([{price:"9.95"}]);
  });
});
