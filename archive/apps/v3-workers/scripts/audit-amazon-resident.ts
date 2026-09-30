import fs from "node:fs/promises";import assert from "node:assert/strict";import{hostname}from"node:os";import pg from"pg";
import{EgoCliRunner}from"@crawl-automation/v3-acquisition";
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const root="/Users/barry/apps/crawlv3-batch-a.UiA4dx",dir=root+"/live/amazon-resident-20260911",read=async(p:string)=>JSON.parse(await fs.readFile(p,"utf8"));
const activation=await read(dir+"/evidence/activation.json");assert.equal(activation.status,"ready");
const targets=new Set<string>();
for(const n of["store","product","gallery","gallery2","rendered","rendered2","rendered3"]){const r=await read(root+"/live/amazon-20260911-"+n+"/report.json");assert.equal(r.closed,true);assert.equal(r.held,false);targets.add(r.targetId);}
for(const n of await fs.readdir(root+"/live/amazon-entry-20260911")){try{const r=await read(root+"/live/amazon-entry-20260911/"+n+"/report.json");if(r.targetId){assert.equal(r.pageClosed,true);assert.equal(r.held,false);targets.add(r.targetId);}}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
const request=await read(root+"/live/amazon-entry-20260911/request-c0980919-55ea-4d65-9ad1-6a023dbf3721/report.json");assert.equal(request.verified,true);for(const p of request.pages){assert.equal(p.closed,true);targets.add(p.targetId);}
// First failed directory's exact page was closed and its permit separately recovered with retained R2 proof.
targets.add("9872FEA96A12398BC41F9B49E824FFC7");
const inventory=await new EgoCliRunner().run("/Users/barry/.local/bin/ego-browser","await useOrCreateTaskSpace(1);const snapshot={tabs:await listTabs()};",AbortSignal.timeout(20000)) as any;
const present=new Set(inventory.tabs.map((t:any)=>t.targetId));assert.ok(present.has("6FD7CA5D547F892EF38717857FBED5F7"));assert.ok([...targets].every(t=>!present.has(t)));assert.ok(targets.size>=13);
const manifest=await read(root+"/live/deployment.json"),status=await read(root+"/status.json"),baseline=await read(dir+"/baseline.json");assert.equal(status.jobs.length,90);assert.ok(status.jobs.every((j:any)=>j.ready));assert.ok(status.dependencies.every((d:any)=>d.healthy));assert.ok(Date.now()-Date.parse(status.at)<15000);
const db=new pg.Pool({connectionString:manifest.database.connectionString,options:"-c default_transaction_read_only=on",statement_timeout:5000});
try{const counts:Record<string,number>={};for(const table of["collected_product","review_record","processing_result","collection_submission"])counts[table]=(await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
for(const[table,hashes]of Object.entries(baseline.hashes))assert.deepEqual((await db.query(`SELECT record_hash FROM ${table} ORDER BY record_hash`)).rows.map(r=>r.record_hash),hashes);
const held=(await db.query("SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL")).rows[0].n,guards=(await db.query("SELECT count(*)::int n FROM source_submission_guard")).rows[0].n;assert.equal(held,0);assert.equal(guards,0);assert.equal(counts.collection_submission,baseline.submissions);
const capacities=(await db.query("SELECT resource_id,capacity,healthy,health_until>now() AS fresh FROM resource_capacity ORDER BY resource_id")).rows;assert.ok(capacities.every(r=>r.healthy&&r.fresh));
const report={at:new Date().toISOString(),verified:true,workers:90,dependencies:status.dependencies,counts,held,guards,capacities,closedTargets:[...targets],remainingTaskTargets:[],originalDashboardPreserved:true,remainingTabs:inventory.tabs.length,businessHashesUnchangedSinceActivation:true};await fs.writeFile(dir+"/evidence/final-audit.json",JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}finally{await db.end();}
