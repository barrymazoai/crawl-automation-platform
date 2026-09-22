// Operational cleanup for this manually launched Amazon/ScraperAPI campaign.
// Pause intake on an ended permit owner, drain other products, stop exact executors,
// retain stop evidence, then release. This does not turn errors into successes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const terminal=new Set(['COMPLETED','FAILED','CANCELLED','TERMINATED','TIMED_OUT']);
export function protectedActivities(request,events,decode){
 const scheduled=events.filter(e=>e.activityTaskScheduledEventAttributes);
 const ended=e=>events.find(x=>[x.activityTaskCompletedEventAttributes,x.activityTaskFailedEventAttributes,x.activityTaskTimedOutEventAttributes,x.activityTaskCanceledEventAttributes].some(v=>String(v?.scheduledEventId)===String(e.eventId)));
 for(const e of scheduled)assert.ok(ended(e),'Pending Activity');
 const grant=scheduled.filter(e=>e.activityTaskScheduledEventAttributes.activityType?.name==='reserveResources'&&decode(e.activityTaskScheduledEventAttributes.input)?.permitId===request.permitId).map(ended).find(e=>decode(e?.activityTaskCompletedEventAttributes?.result)?.status==='granted');assert.ok(grant,'Exact grant not found');
 const effects=scheduled.filter(e=>Number(e.eventId)>Number(grant.eventId)&&!['reserveResources','releaseResources','verifyResourceReviewStopped'].includes(e.activityTaskScheduledEventAttributes.activityType?.name));
 const bound=effects.filter(e=>e.activityTaskScheduledEventAttributes.activityId===request.permitId),failed=effects.filter(e=>{const x=ended(e);return x.activityTaskFailedEventAttributes||x.activityTaskTimedOutEventAttributes||x.activityTaskCanceledEventAttributes;});
 const affected=bound.length?bound:failed.length?failed:effects.slice(0,1);assert.ok(affected.length,'Protected execution not identified');return affected;
}
export function recoveryDecision(permits,products){
 const ended=permits.filter(p=>terminal.has(p.status));
 if(!ended.length)return {pause:false,recover:false};
 // No new products enter while a failed execution is being reclaimed. Existing
 // work is allowed to finish before recycling its shared executor processes.
 return {pause:true,recover:products.length>0&&products.every(p=>terminal.has(p.status))&&permits.every(p=>terminal.has(p.status))};
}
export async function inspectClosedBatchPermits({db,client,state}){
 const held=(await db.query('SELECT request FROM resource_permit WHERE released_at IS NULL')).rows;
 if(!held.length)return {pause:false,recover:false,permits:[],products:[]};
 const ids=state.entries.filter(e=>!['PENDING','CLOSED'].includes(e.state)).map(e=>e.requestId);
 const discoveries=(await db.query("SELECT record->>'workflowId' id FROM catalog_discovery WHERE catalog_id=ANY($1)",[ids])).rows;
 const owned=new Set(discoveries.flatMap(d=>[d.id,d.id+'-label']));
 const relevant=held.filter(p=>owned.has(p.request.workflowId));
 const permits=await Promise.all(relevant.map(async p=>({...p,status:(await client.workflow.getHandle(p.request.workflowId,p.request.runId).describe()).status.name})));
 if(!permits.some(p=>terminal.has(p.status)))return {pause:false,recover:false,permits,products:[]};
 // Foreign work is never stopped by a campaign cleanup.
 if(held.length!==relevant.length)return {pause:true,recover:false,permits,products:[],reason:'FOREIGN_PERMITS_ACTIVE'};
 const products=[],children=[];for(let i=0;i<discoveries.length;i+=6)await Promise.all(discoveries.slice(i,i+6).map(async d=>{const s=await client.workflow.getHandle(d.id).describe();products.push({workflowId:d.id,runId:s.runId,status:s.status.name});try{const c=await client.workflow.getHandle(d.id+'-label').describe();children.push({status:c.status.name});}catch(e){if(e.name!=='WorkflowNotFoundError')throw e;}}));
 return {...recoveryDecision(permits,[...products,...children]),permits,products};
}
export async function recoverClosedBatchPermits({snapshot,db,client,root,out,m,ps,auditOnly=false}){
 assert.equal(snapshot.recover,true);const read=p=>JSON.parse(fs.readFileSync(p)),save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2),{mode:0o600});
 const amazon=m.jobs.find(j=>j.id==='amazon-capture');assert.equal(read(amazon.env.V3_AMAZON_LIVE_CONFIG).capture.mode,'scraperapi');
 const {defaultPayloadConverter}=createRequire(root+'/package.json')('@temporalio/common');
 const decode=p=>p?.payloads?.length===1?defaultPayloadConverter.fromPayload(p.payloads[0]):null;
 const id=randomUUID(),dir=out+'/failure-cleanup/'+id;fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const permittedResources=new Set(['mini-cpu','mini-model-account','windows-ocr','scraperapi-lane','amazon-file-lane']);
 const queues=new Set(),affectedActivities=new Set(),facts=[];
 for(const p of snapshot.permits){assert.ok(p.request.needs.every(n=>permittedResources.has(n.resourceId)),'Unsupported resource must be inspected explicitly');
  const handle=client.workflow.getHandle(p.request.workflowId,p.request.runId),s=await handle.describe();assert.ok(terminal.has(s.status.name));assert.equal(s.raw.pendingActivities?.length??0,0);assert.equal(s.raw.pendingChildren?.length??0,0);
  const h=await handle.fetchHistory(),events=h.events??[],scheduled=events.filter(e=>e.activityTaskScheduledEventAttributes);
  const affected=protectedActivities(p.request,events,decode);
  for(const e of affected){queues.add(e.activityTaskScheduledEventAttributes.taskQueue.name);affectedActivities.add(e.activityTaskScheduledEventAttributes.activityType.name);}
  const bytes=Buffer.from(JSON.stringify(h));fs.writeFileSync(dir+'/'+p.request.permitId+'-history.json',bytes,{mode:0o600});facts.push({request:p.request,status:s.status.name,historySha256:sha(bytes),activities:affected.map(e=>({name:e.activityTaskScheduledEventAttributes.activityType.name,id:e.activityTaskScheduledEventAttributes.activityId}))});
 }
 // This recovery is deliberately scoped to the current HTTP capture deployment.
 // A real browser lease always needs its separate exact-page recovery.
 for(const p of snapshot.products){const h=await client.workflow.getHandle(p.workflowId,p.runId).fetchHistory(),events=h.events??[];
  const closes=events.filter(e=>e.activityTaskScheduledEventAttributes?.activityType?.name==='closeAmazonProductPage');
  if(!snapshot.permits.some(x=>x.request.workflowId===p.workflowId||x.request.workflowId===p.workflowId+'-label'))continue;
  assert.ok(closes.length);for(const e of closes){const end=events.find(x=>String(x.activityTaskCompletedEventAttributes?.scheduledEventId)===String(e.eventId));assert.equal(decode(end?.activityTaskCompletedEventAttributes?.result)?.status,'not-opened');}
 }
 const queue=r=>`v3.${r.capability}.v${r.contractVersion}.${r.compatibility}${r.queueScope?'.session.'+r.queueScope:''}`;
 const jobs=m.jobs.filter(j=>j.env.V3_WORKER_CONFIG&&queues.has(queue(read(j.env.V3_WORKER_CONFIG))));assert.ok(jobs.length&&jobs.every(j=>j.id.startsWith('amazon-')));
 const old=jobs.map(j=>({id:j.id,...read(root+'/'+j.id+'.health.json')}));assert.ok(old.every(j=>j.event==='WORKER_RUNNING'));
 for await(const w of client.workflow.list({query:'ExecutionStatus = "Running"'})){const s=await client.workflow.getHandle(w.workflowId,w.runId).describe();assert.ok((s.raw.pendingActivities??[]).every(a=>s.type==='BrandCollectionWorkflow'&&a.activityType?.name==='inspectBrandCollection'),'Other work still executing');assert.equal(s.raw.pendingChildren?.length??0,0,'Another child is still running');}
 const model=['interpretText','interpretImage'].some(n=>affectedActivities.has(n));
 const ocr=snapshot.permits.some(p=>p.request.needs.some(n=>n.resourceId==='windows-ocr'));
 const cloudDir=String.raw`D:\crawlv3-cloud\logs\failure-cleanup-${id}`;
 if(auditOnly){const proof={at:new Date().toISOString(),facts,jobs:old.map(j=>({id:j.id,pid:j.pid,identity:j.identity})),model,ocr,mutations:0};save(dir+'/audit.json',proof);return proof;}
 const stopped=[];let windows=null,windowsAttempted=false;const restored=[];
 const absent=pid=>{try{process.kill(pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}};
 try{
  save(dir+'/intent.json',{at:new Date().toISOString(),facts,jobs:old.map(j=>({id:j.id,pid:j.pid,identity:j.identity,buildId:j.buildId})),model,ocr});
  for(const j of old){assert.equal(read(root+'/'+j.id+'.health.json').identity,j.identity);const p=(await exec('/bin/ps',['-axo','pid=,ppid=,comm='])).stdout.trim().split('\n').map(l=>{const a=/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(l);return a?{pid:+a[1],ppid:+a[2],comm:a[3]}:null;}).filter(Boolean);
   const owned=new Set([j.pid]);for(let n=0;n<12;n++){const next=p.filter(x=>owned.has(x.ppid)&&!owned.has(x.pid));if(!next.length)break;next.forEach(x=>owned.add(x.pid));}
   const children=p.filter(x=>x.pid!==j.pid&&owned.has(x.pid));assert.ok(children.every(x=>/(^|\/)codex$/.test(x.comm)),'Unknown child: never kill a browser or unrelated process');
   stopped.push(j);await exec(m.node,[root+'/manual-control.mjs','stop',j.id],{timeout:180000,maxBuffer:2000000});assert.ok(absent(j.pid));
   for(const child of children)if(!absent(child.pid)){const current=(await exec('/bin/ps',['-p',String(child.pid),'-o','comm='])).stdout.trim();assert.equal(current,child.comm);process.kill(child.pid,'SIGTERM');await new Promise(r=>setTimeout(r,1000));if(!absent(child.pid))process.kill(child.pid,'SIGKILL');}
   for(const child of children){for(let n=0;n<20&&!absent(child.pid);n++)await new Promise(r=>setTimeout(r,100));assert.ok(absent(child.pid));}
  }
  if(model||ocr){
   // Only the existing project-owned Windows services; no OCR Worker or login task.
   windowsAttempted=true;windows=ps(String.raw`$dir='${cloudDir}'
New-Item -ItemType Directory $dir|Out-Null
$proof=[ordered]@{dir=$dir;model=${model?'$true':'$false'};ocr=${ocr?'$true':'$false'};oldPids=@()}
$proof|ConvertTo-Json -Depth 5|Set-Content ($dir+'\progress.json') -Encoding UTF8
if($proof.model){
 $state=Get-Content 'D:\crawlv3-cloud\private\cloud-status.json' -Raw|ConvertFrom-Json
 $lock=Get-Content 'D:\crawlv3-cloud\private\cloud-supervisor.lock' -Raw|ConvertFrom-Json
 if($state.supervisorPid -ne $lock.pid -or $state.sessionId -ne $lock.sessionId){throw 'Cloud owner changed'}
 if(Test-Path 'D:\crawlv3-cloud\private\STOP-cloud'){throw 'Cloud already stopped by user'}
 $all=@(Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate)
 $owner=@($all|Where-Object {$_.ProcessId -eq $lock.pid});if($owner.Count -ne 1 -or $owner[0].Name -ne 'node.exe'){throw 'Cloud PID identity changed'}
 $ids=@([int]$lock.pid);for($i=0;$i -lt 12;$i++){$add=@($all|Where-Object {$ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId}|ForEach-Object {[int]$_.ProcessId});if(!$add.Count){break};$ids+=$add}
 if(@($all|Where-Object {$ids -contains [int]$_.ProcessId -and ($_.Name -notin @('node.exe','codex.exe','conhost.exe') -or ($_.Name -eq 'conhost.exe' -and $_.ExecutablePath -ne ($env:WINDIR+'\System32\conhost.exe')))}).Count){throw 'Unexpected cloud child'}
 $proof.cloudOwner=$lock;$proof.cloudBuild=$state.buildId;$proof.oldPids+=$ids
 $proof.cloudStopRequested=$true;$proof|ConvertTo-Json -Depth 5|Set-Content ($dir+'\progress.json') -Encoding UTF8
 Set-Content 'D:\crawlv3-cloud\private\STOP-cloud' '${id}' -Encoding ASCII
 $until=(Get-Date).AddSeconds(30);do{$remaining=@(Get-Process -Id $ids -ErrorAction SilentlyContinue);if(!$remaining.Count){break};Start-Sleep -Milliseconds 500}while((Get-Date)-lt $until)
 foreach($p in $remaining){$prior=@($all|Where-Object {$_.ProcessId -eq $p.Id});$now=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.Id);if($now -and ($now.CreationDate -ne $prior[0].CreationDate -or $now.ExecutablePath -ne $prior[0].ExecutablePath)){throw 'Cloud PID reused'};if($now){Stop-Process -Id $p.Id -Force -ErrorAction Stop}}
 if(@(Get-Process -Id $ids -ErrorAction SilentlyContinue).Count){throw 'Cloud process remains'}
 if(Test-Path 'D:\crawlv3-cloud\private\cloud-supervisor.lock'){$current=Get-Content 'D:\crawlv3-cloud\private\cloud-supervisor.lock' -Raw|ConvertFrom-Json;if($current.sessionId -ne $lock.sessionId){throw 'Cloud lock changed'};Remove-Item 'D:\crawlv3-cloud\private\cloud-supervisor.lock'}
 $proof.cloudStopped=$true;$proof|ConvertTo-Json -Depth 5|Set-Content ($dir+'\progress.json') -Encoding UTF8
}
if($proof.ocr){
 $all=@(Get-CimInstance Win32_Process)
 $parent=@($all|Where-Object {$_.ExecutablePath -eq 'D:\ocr\python\python.exe' -and $_.CommandLine -match '\-m uvicorn ocr_server:app' -and $_.CommandLine -match '\-\-port 8081'})
 if($parent.Count -ne 1){throw 'OCR owner ambiguous'}
 $ids=@([int]$parent[0].ProcessId);for($i=0;$i -lt 12;$i++){$add=@($all|Where-Object {$ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId}|ForEach-Object {[int]$_.ProcessId});if(!$add.Count){break};$ids+=$add}
 if($ids.Count -ne 5 -or @($all|Where-Object {$ids -contains [int]$_.ProcessId -and $_.ExecutablePath -ne 'D:\ocr\python\python.exe'}).Count){throw 'OCR process tree changed'}
 $proof.ocrStopRequested=$true;$proof.ocrPids=$ids;$proof|ConvertTo-Json -Depth 5|Set-Content ($dir+'\progress.json') -Encoding UTF8
 & "$env:WINDIR\System32\taskkill.exe" /PID $parent[0].ProcessId /T /F |Out-Null
 if($LASTEXITCODE -ne 0 -or @(Get-Process -Id $ids -ErrorAction SilentlyContinue).Count){throw 'OCR stop failed'}
 $proof.oldPids+=$ids
 $proof.ocrStopped=$true;$proof|ConvertTo-Json -Depth 5|Set-Content ($dir+'\progress.json') -Encoding UTF8
}
$proof.at=(Get-Date).ToUniversalTime().ToString('o');$proof.allOldProcessesAbsent=$true
$proof|ConvertTo-Json -Depth 5|Set-Content ($dir+'\stopped.json') -Encoding UTF8
$proof|ConvertTo-Json -Depth 5 -Compress`);
   assert.equal(windows.allOldProcessesAbsent,true);
  }
  const cfg=read(m.jobs.find(j=>j.id==='amazon-channel-label-collection').env.V3_CHANNEL_LABEL_CONFIG),{S3Client,PutObjectCommand,GetObjectCommand}=createRequire(root+'/source/packages/v3-artifacts/package.json')('@aws-sdk/client-s3');
  const r2=new S3Client({endpoint:cfg.r2.endpoint,region:'auto',credentials:cfg.r2Credentials,maxAttempts:1,forcePathStyle:true,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  const key='v3/manual-batch-cleanup/'+id+'/proof.json',proof={codec:'stopped-batch-executors/1',at:new Date().toISOString(),facts,windows,mini:old.map(j=>({id:j.id,pid:j.pid,identity:j.identity,absent:absent(j.pid)}))},bytes=Buffer.from(JSON.stringify(proof));
  try{await r2.send(new PutObjectCommand({Bucket:cfg.r2.bucket,Key:cfg.r2.prefix+'/'+key,Body:bytes,ContentType:'application/json',IfNoneMatch:'*'}),{abortSignal:AbortSignal.timeout(45000)});const r=await r2.send(new GetObjectCommand({Bucket:cfg.r2.bucket,Key:cfg.r2.prefix+'/'+key}),{abortSignal:AbortSignal.timeout(45000)});assert.equal(sha(Buffer.from(await r.Body.transformToByteArray())),sha(bytes));}finally{r2.destroy();}
  save(dir+'/stopped-proof.json',{...proof,key});
  const tx=await db.connect();try{await tx.query('BEGIN');for(const {request} of facts){const row=(await tx.query('SELECT request FROM resource_permit WHERE permit_id=$1 FOR UPDATE',[request.permitId])).rows[0];assert.deepEqual(row.request,request);await tx.query('UPDATE resource_permit SET released_at=coalesce(released_at,now()) WHERE permit_id=$1',[request.permitId]);}await tx.query('COMMIT');}catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
  save(dir+'/released.json',{at:new Date().toISOString(),permits:facts.map(f=>f.request.permitId),key});
 }finally{
  const restoreErrors=[];
  // Recover completed stop stages even if a later stage failed. Unconfirmed stops
  // remain visible and keep intake paused; never launch over a surviving owner.
  if(windowsAttempted){try{ps(String.raw`$dir='${cloudDir}'
if(!(Test-Path ($dir+'\progress.json'))){throw 'Windows stop progress unavailable'}
$saved=Get-Content ($dir+'\progress.json') -Raw|ConvertFrom-Json
if($saved.cloudStopRequested -and !$saved.cloudStopped){throw 'Partial cloud stop requires reconciliation'}
if($saved.ocrStopRequested -and !$saved.ocrStopped){throw 'Partial OCR stop requires reconciliation'}
if($saved.cloudStopped){
 if(@(Get-Process -Id $saved.oldPids -ErrorAction SilentlyContinue).Count){throw 'Old Windows owner still present'}
 $marker=(Get-Content 'D:\crawlv3-cloud\private\STOP-cloud' -Raw).Trim();if($marker -ne '${id}'){throw 'Stop marker owner changed'}
 Remove-Item 'D:\crawlv3-cloud\private\STOP-cloud'
 $p=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe D:\crawlv3-cloud\cloud-supervisor.mjs '+$dir)}
 if($p.ReturnValue -ne 0){throw 'Cloud restart failed'}
}
if($saved.ocrStopped){
 [IO.File]::WriteAllText($dir+'\start-ocr.cmd',('@echo off'+[Environment]::NewLine+'call D:\ocr\service\start-nvidia.cmd 1>'+$dir+'\ocr.stdout.log 2>'+$dir+'\ocr.stderr.log'),[Text.Encoding]::ASCII)
 $p=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('cmd.exe /d /c '+$dir+'\start-ocr.cmd')};if($p.ReturnValue -ne 0){throw 'OCR restart failed'}
}
[pscustomobject]@{restartRequested=$true}|ConvertTo-Json -Compress`);}catch(e){restoreErrors.push({host:'windows',error:e.code??e.name});}}
  for(const j of stopped){try{await exec(m.node,[root+'/manual-control.mjs','start',j.id],{timeout:180000,maxBuffer:2000000});const h=read(root+'/'+j.id+'.health.json');assert.equal(h.event,'WORKER_RUNNING');assert.equal(h.buildId,j.buildId);assert.notEqual(h.pid,j.pid);restored.push({id:j.id,pid:h.pid});}catch(e){restoreErrors.push({id:j.id,error:e.code??e.name});}}
  if(windows&&restoreErrors.length===0){try{const check=ps(String.raw`$until=(Get-Date).AddSeconds(40);$ready=$false
do{
 $modelReady=$true;$ocrReady=$true
 if(${model?'$true':'$false'}){$s=Get-Content 'D:\crawlv3-cloud\private\cloud-status.json' -Raw|ConvertFrom-Json;$modelReady=(!$s.stopping -and @($s.workers|Where-Object {$_.state -eq 'running'}).Count -eq 2 -and $s.buildId -eq '${windows.cloudBuild??''}')}
 if(${ocr?'$true':'$false'}){try{$h=Invoke-RestMethod 'http://127.0.0.1:8081/health' -TimeoutSec 3;$ocrReady=($h.status -eq 'ok' -and $h.healthy_backends -eq 4 -and $h.total_backends -eq 4)}catch{$ocrReady=$false}}
 $ready=$modelReady -and $ocrReady;if($ready){break};Start-Sleep -Seconds 1
}while((Get-Date)-lt $until)
[pscustomobject]@{ready=$ready}|ConvertTo-Json -Compress`);assert.equal(check.ready,true);}catch(e){restoreErrors.push({host:'windows-health',error:e.code??e.name});}}
  save(dir+'/restored.json',{at:new Date().toISOString(),mini:restored,windowsRestartRequested:!!windows,errors:restoreErrors});assert.equal(restoreErrors.length,0,'Executor restoration needs reconciliation; intake remains stopped');
 }
 return {at:new Date().toISOString(),released:facts.length,dir};
}
