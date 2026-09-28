// One explicit reconciliation of the failed 2026-09-22 stop. No business retry,
// no kill, no capacity change, no Review mutation and no automatic repeat.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {hostname} from 'node:os';
assert.match(hostname(),/^servers-Mac-mini(?:\.|$)/);
const apply=process.argv[2]==='--apply';assert.ok(apply||process.argv[2]==='--audit');
const root='/Users/server/apps/crawler-v3',id='7ae7d8b7-41df-40f2-99aa-846882288a3f',permit='permit-01a0c9b5-954b-7282-a374-a8760e9cf2ab-0';
const read=p=>JSON.parse(fs.readFileSync(p)),hc=read(root+'/manual-releases/promises-20260922/health.private.json'),m=read(root+'/live/deployment.json');
const old=hc.out+'/failure-cleanup/'+id,intent=read(old+'/intent.json'),fact=intent.facts.find(f=>f.request.permitId===permit);
assert.ok(fact);assert.deepEqual(fact.request.needs,[{resourceId:'windows-ocr',units:1}]);assert.equal(intent.ocr,true);assert.equal(intent.model,false);
const ps=source=>JSON.parse(execFileSync('/usr/bin/ssh',[...hc.windowsSsh,'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '+Buffer.from("$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';"+source,'utf16le').toString('base64')],{encoding:'utf8',timeout:60000,maxBuffer:200000,stdio:['pipe','pipe','pipe']}));
const req=createRequire(root+'/source/apps/v3-workers/package.json'),{Pool}=req('pg'),{Connection,Client}=req('@temporalio/client');
const db=new Pool({connectionString:m.database.connectionString,statement_timeout:10000,max:1});
let connection;
try{
 const held=(await db.query('SELECT request FROM resource_permit WHERE released_at IS NULL')).rows;
 assert.equal(held.length,1);assert.deepEqual(held[0].request,fact.request);
 const cfg=read(hc.connectionFile),t=cfg.transport;
 connection=await Connection.connect({address:cfg.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:fs.readFileSync(t.caFile),clientCertPair:{crt:fs.readFileSync(t.certFile),key:fs.readFileSync(t.keyFile)}}});
 const client=new Client({connection,namespace:hc.namespace});
 const owner=await client.workflow.getHandle(fact.request.workflowId,fact.request.runId).describe();
 assert.ok(['COMPLETED','FAILED','CANCELLED','TERMINATED','TIMED_OUT'].includes(owner.status.name));assert.equal(owner.raw.pendingActivities?.length??0,0);
 for await(const w of client.workflow.list({query:'ExecutionStatus = "Running"'})){
  const s=await client.workflow.getHandle(w.workflowId,w.runId).describe();assert.ok((s.raw.pendingActivities??[]).every(a=>s.type==='BrandCollectionWorkflow'&&a.activityType?.name==='inspectBrandCollection'));assert.equal(s.raw.pendingChildren?.length??0,0);
 }
 const stopped=ps(String.raw`$p=Get-Content 'D:\crawlv3-cloud\logs\failure-cleanup-${id}\progress.json' -Raw|ConvertFrom-Json
if(!$p.ocrStopRequested -or $p.ocrStopped -or $p.model){throw 'Unexpected old stop progress'}
$ids=@(13660,19288,16360,24360,8196)
if(@(Compare-Object $ids @($p.ocrPids)).Count){throw 'Old OCR identities changed'}
if(@(Get-Process -Id $ids -ErrorAction SilentlyContinue).Count){throw 'Old process still exists'}
if(@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -eq 'D:\ocr\python\python.exe'}).Count){throw 'OCR execution still exists'}
[pscustomobject]@{at=(Get-Date).ToUniversalTime().ToString('o');oldPids=$ids;allAbsent=$true;ocrExecutors=0}|ConvertTo-Json -Compress`);
 assert.equal(stopped.allAbsent,true);assert.equal(stopped.ocrExecutors,0);
 const proof={codec:'explicit-ocr-stop-reconciliation/1',at:new Date().toISOString(),originalAttempt:id,request:fact.request,historySha256:fact.historySha256,ownerStatus:owner.status.name,windows:stopped,businessRetries:0};
 if(!apply){console.log(JSON.stringify({audit:true,...proof}));}
 else{
  // The file is an execution claim. Do not delete it or run this command again
  // after a lost acknowledgement; inspect the retained stage files instead.
  const out=hc.out+'/ocr-reconciliation-20260923';fs.mkdirSync(out,{mode:0o700});
  fs.writeFileSync(out+'/intent.json',JSON.stringify(proof),{flag:'wx',mode:0o600});
  const c=read(m.jobs.find(j=>j.id==='amazon-channel-label-collection').env.V3_CHANNEL_LABEL_CONFIG),{S3Client,PutObjectCommand,GetObjectCommand}=req('@aws-sdk/client-s3');
  const r2=new S3Client({endpoint:c.r2.endpoint,region:'auto',credentials:c.r2Credentials,maxAttempts:1,forcePathStyle:true,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  const key='v3/manual-batch-cleanup/ocr-reconciliation-20260923/proof.json',bytes=Buffer.from(JSON.stringify(proof)),digest=b=>createHash('sha256').update(b).digest('hex');
  try{
   let putError;try{await r2.send(new PutObjectCommand({Bucket:c.r2.bucket,Key:c.r2.prefix+'/'+key,Body:bytes,IfNoneMatch:'*',ContentType:'application/json'}),{abortSignal:AbortSignal.timeout(30000)});}catch(e){putError=e;}
   const got=await r2.send(new GetObjectCommand({Bucket:c.r2.bucket,Key:c.r2.prefix+'/'+key}),{abortSignal:AbortSignal.timeout(30000)});
   assert.equal(digest(Buffer.from(await got.Body.transformToByteArray())),digest(bytes));
   fs.writeFileSync(out+'/proof.json',JSON.stringify({...proof,key,writeAcknowledgementLost:!!putError}),{mode:0o600});
  }finally{r2.destroy();}
  const tx=await db.connect();try{await tx.query('BEGIN');const current=(await tx.query('SELECT request,released_at FROM resource_permit WHERE permit_id=$1 FOR UPDATE',[permit])).rows[0];assert.deepEqual(current.request,fact.request);assert.equal(current.released_at,null);await tx.query('UPDATE resource_permit SET released_at=now() WHERE permit_id=$1',[permit]);await tx.query('COMMIT');}catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
  fs.writeFileSync(out+'/released.json',JSON.stringify({at:new Date().toISOString(),permit,key}),{mode:0o600});
  const start=ps(String.raw`$dir='D:\crawlv3-cloud\logs\ocr-reconciliation-20260923'
if(Test-Path $dir){throw 'Reconciliation already attempted'}
if(@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -eq 'D:\ocr\python\python.exe'}).Count){throw 'OCR already present'}
New-Item -ItemType Directory $dir|Out-Null
[IO.File]::WriteAllText($dir+'\start.cmd',('@echo off'+[Environment]::NewLine+'call D:\ocr\service\start-nvidia.cmd 1>'+ $dir+'\stdout.log 2>'+ $dir+'\stderr.log'),[Text.Encoding]::ASCII)
$p=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('cmd.exe /d /c '+$dir+'\start.cmd')}
if($p.ReturnValue -ne 0){throw 'OCR start failed'}
[pscustomobject]@{pid=$p.ProcessId;attempts=1}|ConvertTo-Json -Compress`);
  fs.writeFileSync(out+'/start-requested.json',JSON.stringify(start),{mode:0o600});console.log(JSON.stringify({released:permit,ocrStart:start,queueResumed:false,proof:key}));
 }
}finally{await connection?.close();await db.end();}
