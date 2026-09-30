import {expect,it} from "vitest";
import {hostname} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {readFile,writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {CatalogPageSchema} from "@crawl-automation/v3-contracts";
import {catalogPage} from "../../../packages/v3-contracts/src/catalog.fixture.js";
import {PostgresCatalog} from "../../../packages/v3-product/src/catalog-ledger.js";
it("Mini Postgres: exact family count closes the directory but cannot confirm a missing SKU",async()=>{
 expect(hostname()).toMatch(/^barrydeMac-mini(?:\.|$)/);
 const dir=dirname(fileURLToPath(import.meta.url)),root="/Users/barry/apps/crawlv3-batch-a.UiA4dx",m=JSON.parse(await readFile(root+"/live/deployment.json","utf8"));
 expect(new URL(m.database.connectionString).pathname).toBe("/crawler_v3_test");
 const schema="coverage_"+randomUUID().replaceAll("-",""),admin=new pg.Pool({connectionString:m.database.connectionString,max:1});
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.end();
 const db=new pg.Pool({connectionString:m.database.connectionString,max:2,options:`-c search_path=${schema}`});
 try{
  await db.query("CREATE TABLE processing_result(record jsonb)");await db.query(await readFile(join(dir,"013_catalog_presence.sql"),"utf8"));
  const ledger=new PostgresCatalog(db,async p=>{CatalogPageSchema.parse(p);expect(p.source.objectKey).toMatch(/^synthetic\//);});
  const page=(id:string,n:number,entries:string[],count:number|undefined,end=false)=>{
   const p=catalogPage(id,n,end?"complete":"more",entries);p.input.scope={...p.input.scope,channel:"swanson"};
   p.entries=p.entries.map(e=>({...e,kind:"family",variantId:null}));if(count!==undefined)p.familyCount=count;return CatalogPageSchema.parse(p);
  };
  const commit=async(p:ReturnType<typeof page>,dispatch=true)=>{const r=await ledger.commit(p);if(dispatch)for(const d of r.discoveries)await ledger.dispatch({discovery:d,workflowId:d.workflowId,runId:randomUUID()});return r;};
  const outcomes=[];
  for(const mode of ["exact","duplicate-missing","changed-total","missing-count","pending-dispatch"]){
   const first=page(mode,0,["a","a"],2),last=page(mode,1,mode==="duplicate-missing"?["a"]:["b"],mode==="changed-total"?3:mode==="missing-count"?undefined:2,true);
   expect((await commit(first)).discoveries).toHaveLength(1);await commit(last,mode!=="pending-dispatch");
   const closed=await ledger.close({catalogId:mode,scope:first.input.scope,failure:null});expect(closed.status).toBe(mode==="exact"?"complete":"incomplete");
   const presence=await ledger.presence({operationId:"presence-"+mode,catalogId:mode,scope:first.input.scope,listingId:"missing-sku",variantId:"unseen-variant"});expect(presence.status).toBe("unknown");
   outcomes.push({mode,closure:closed.status,presence:presence.status});
  }
  const legacy=catalogPage("legacy",0,"complete");await commit(legacy);expect(await ledger.close({catalogId:"legacy",scope:legacy.input.scope,failure:null})).toEqual({status:"complete"});
  expect((await ledger.presence({operationId:"legacy-absent",catalogId:"legacy",scope:legacy.input.scope,listingId:"missing",variantId:null})).status).toBe("confirmed_absent");
  const record=(await db.query("SELECT record FROM catalog_closure WHERE catalog_id='exact'")).rows[0].record;expect(record.coverage).toEqual({unit:"families",expected:2,discovered:2});
  await writeFile(join(dir,"catalog-ledger-proof.json"),JSON.stringify({passed:true,schema,publicBusinessTablesUntouched:true,outcomes,legacyAbsencePreserved:true},null,2));
 }finally{await db.end();}
},30000);
