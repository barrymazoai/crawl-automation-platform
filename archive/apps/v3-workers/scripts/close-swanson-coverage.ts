import assert from "node:assert/strict";
import {hostname} from "node:os";
import {readFile,readdir,writeFile} from "node:fs/promises";
import pg from "pg";
import {EgoCliRunner} from "@crawl-automation/v3-acquisition";
import {PostgresResourceAdmission} from "../../../packages/v3-product/src/resource-admission.js";
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const root="/Users/barry/apps/crawlv3-batch-a.UiA4dx",dir=process.argv[2]!;
assert.match(dir,new RegExp("^"+root.replaceAll(".","\\.")+"/live/swanson-coverage-[a-f0-9-]{36}$"));
const read=async(p:string)=>JSON.parse(await readFile(p,"utf8")),report=await read(dir+"/report.json");
assert.equal(report.status,"failed");assert.equal(report.products.length,0);assert.ok(report.held);assert.match(report.permit.workflowId,/^manual-swanson-coverage-/);
const opened=[];for(const file of await readdir(dir+"/journal",{recursive:true}))if(file.endsWith("/opened.json")){
 const p=await read(dir+"/journal/"+file);assert.deepEqual(await read(dir+"/journal/"+file.replace("/opened.json","/closed.json")),p);opened.push(p);
}
assert.equal(opened.length,4);
const tabs=await new EgoCliRunner().run("/Users/barry/.local/bin/ego-browser","await useOrCreateTaskSpace(1);const snapshot=await listTabs();",AbortSignal.timeout(15000)) as {targetId:string}[];
assert.ok(opened.every(p=>!tabs.some(t=>t.targetId===p.targetId)));
const manifest=await read(root+"/live/deployment.json"),db=new pg.Pool({connectionString:manifest.database.connectionString,max:1});
try{const result=await new PostgresResourceAdmission(db).release(report.permit);assert.equal(result.status,"released");
 const proof={at:new Date().toISOString(),knownProcessExited:true,allOpenedPagesClosedAndAbsent:true,targets:opened.map(p=>p.targetId),permit:report.permit.permitId,released:true};
 await writeFile(dir+"/cleanup-after-failure.json",JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{await db.end();}
