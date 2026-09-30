/** Clone only the scoped V3 test database, migrate the clone, leave resident database untouched. */
import assert from "node:assert/strict";
import {execFile,spawn} from "node:child_process";
import {promisify} from "node:util";
import {readFile,writeFile,mkdtemp} from "node:fs/promises";
import {join} from "node:path";
import {hostname} from "node:os";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {migrationNames,migrate,digest} from "../../v3-api/src/bootstrap/schema.js";
import {assertLabelVisionRegistrySchema} from "@crawl-automation/v3-vision";
import {readGncPrivateJson} from "../src/gnc-config.js";
async function main(){
 assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);const[privatePath]=process.argv.slice(2);assert.ok(privatePath);const base=await readGncPrivateJson(privatePath) as any,u=new URL(base.reviewDatabase.connectionString);assert.equal(u.hostname,"127.0.0.1");assert.equal(u.port,"32806");assert.equal(u.pathname,"/crawler_v3_test");
 const root="/Users/barry/apps/crawlv3-channel-restored.PCrTm6/quality-batch-3",dir=await mkdtemp(join(root,"schema-clone-")),exec=promisify(execFile),docker="/opt/homebrew/bin/docker",source="crawlv3-batch-a-845a2138";
 const snapshot=await exec(docker,["exec",source,"pg_dump","-U",decodeURIComponent(u.username),"-d","crawler_v3_test","--format=custom","--no-owner","--no-acl"],{encoding:"buffer",maxBuffer:67108864});await writeFile(join(dir,"before.dump"),snapshot.stdout,{mode:0o600});
 const container=`crawlv3-quality-${randomUUID().slice(0,8)}`,password=randomUUID(),env=join(dir,"postgres.env");await writeFile(env,`POSTGRES_USER=tester\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=crawler_v3_test\n`,{mode:0o600});
 await exec(docker,["run","-d","--name",container,"--env-file",env,"--publish","127.0.0.1::5432","postgres:18"]);
 const port=Number((await exec(docker,["port",container,"5432/tcp"])).stdout.trim().split(":").at(-1));assert.ok(port);const db=new pg.Pool({host:"127.0.0.1",port,user:"tester",password,database:"crawler_v3_test",connectionTimeoutMillis:1000});
 try{
  for(let i=0;;i++){try{await db.query("SELECT 1");break;}catch{if(i>=60)throw Error("DATABASE_START_TIMEOUT");await new Promise(r=>setTimeout(r,250));}}
  await new Promise<void>((resolve,reject)=>{const child=spawn(docker,["exec","-i",container,"pg_restore","-U","tester","-d","crawler_v3_test","--no-owner","--no-acl"],{stdio:["pipe","ignore","ignore"]});child.on("error",reject);child.on("close",code=>code===0?resolve():reject(Error("RESTORE_FAILED")));child.stdin.end(snapshot.stdout);});
  await assert.rejects(assertLabelVisionRegistrySchema(db,"label-extraction/2"),/SCHEMA_MIGRATION_REQUIRED/);
  const before=(await db.query("SELECT operation_id,record_hash FROM processing_result ORDER BY operation_id")).rows;
  const migrations=await Promise.all(migrationNames.map(async name=>{const sql=await readFile(join(root,"migrations",name),"utf8");return{name,sql,sha256:digest(sql)}}));const c=await db.connect();try{await migrate(c,migrations,async()=>{assert.ok(snapshot.stdout.length>0)})}finally{c.release()}
  await assertLabelVisionRegistrySchema(db,"label-extraction/2");await assertLabelVisionRegistrySchema(db,"label-extraction/1");assert.deepEqual((await db.query("SELECT operation_id,record_hash FROM processing_result ORDER BY operation_id")).rows,before);
  const connectionString=`postgresql://tester:${password}@127.0.0.1:${port}/crawler_v3_test`;
  await writeFile(join(dir,"private.json"),JSON.stringify({...base,reviewDatabase:{connectionString},resourceDatabase:base.reviewDatabase}),{mode:0o600});
  const report={status:"passed",container,clonePrivatePath:join(dir,"private.json"),snapshotSha256:digest(snapshot.stdout),snapshotBytes:snapshot.stdout.length,preservedProcessingRecords:before.length,sourceDatabaseChanged:false,migration:"016_visual_wire_v2.sql"};await writeFile(join(dir,"report.json"),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
 }finally{await db.end();}
}
main().catch(()=>{console.error("VISUAL_SCHEMA_CLONE_REJECTED");process.exitCode=1});
