// Read-only operator view, run on Server 1: reconcile claims, the latest cleanup
// directory, the health file and the Windows fleet state (script hashes, marker,
// lock, node processes, that cleanup's progress). Mutates nothing.
//   node inspect-fleet.mjs [attemptId] 2>/dev/null
import fs from 'node:fs';
const [attemptId]=process.argv.slice(2);
const out='/Users/server/apps/crawler-v3/manual-releases/local-temporal-20260923';
const source='/Users/server/apps/crawler-v3/releases/fleet-20260924/source';
const h=JSON.parse(fs.readFileSync(out+'/health.private.json','utf8'));
const {runWindowsPowerShell}=await import(source+'/apps/v3-workers/src/windows-powershell.mjs');
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){return {unreadable:e.code??e.name};}};
const claims=[...new Set(fs.readdirSync(out+'/recovery-attempts').map(f=>{const c=read(out+'/recovery-attempts/'+f);return JSON.stringify({id:c.id,status:c.status,error:c.error,diagnostics:c.diagnostics,previous:c.previous});}))].map(s=>JSON.parse(s));
const dirs=fs.readdirSync(out+'/failure-cleanup').map(d=>({d,t:fs.statSync(out+'/failure-cleanup/'+d).mtimeMs})).sort((a,b)=>b.t-a.t);
const latest=attemptId??dirs[0]?.d,dir=out+'/failure-cleanup/'+latest;
const cleanup={id:latest,files:fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>!f.endsWith('-history.json')):null,
  executionFailed:fs.existsSync(dir+'/execution-failed.json')?read(dir+'/execution-failed.json'):null,
  restored:fs.existsSync(dir+'/restored.json')?read(dir+'/restored.json'):null,
  released:fs.existsSync(dir+'/released.json')?read(dir+'/released.json'):null,
  publication:fs.existsSync(dir+'/proof-publication.json')?read(dir+'/proof-publication.json'):null};
const health=read(out+'/health.json');
let windows;
try{windows=runWindowsPowerShell(h.windowsSsh,String.raw`$dir='D:\crawlv3-cloud\logs\failure-cleanup-${latest}'
$p=$null;if(Test-Path ($dir+'\progress.json')){$p=Get-Content ($dir+'\progress.json') -Raw|ConvertFrom-Json}
$s=$null;if(Test-Path 'D:\crawlv3-cloud\private\cloud-status.json'){$s=Get-Content 'D:\crawlv3-cloud\private\cloud-status.json' -Raw|ConvertFrom-Json}
$ev=$null;if(Test-Path ($dir+'\supervisor.events.jsonl')){$ev=@(Get-Content ($dir+'\supervisor.events.jsonl')|Select-Object -Last 8|ForEach-Object {[string]$_})}
$ocr=$null;try{$ocr=Invoke-RestMethod 'http://127.0.0.1:8081/health' -TimeoutSec 3|Select-Object status,healthy_backends,total_backends}catch{$ocr='unreachable'}
[pscustomobject]@{supervisorSha=(Get-FileHash 'D:\crawlv3-cloud\cloud-supervisor.mjs' -Algorithm SHA256).Hash.ToLower();statusFileSha=$(if(Test-Path 'D:\crawlv3-cloud\status-file.mjs'){(Get-FileHash 'D:\crawlv3-cloud\status-file.mjs' -Algorithm SHA256).Hash.ToLower()}else{$null});stopMarker=(Test-Path 'D:\crawlv3-cloud\private\STOP-cloud');lock=(Test-Path 'D:\crawlv3-cloud\private\cloud-supervisor.lock');status=$(if($s){[pscustomobject]@{pid=$s.supervisorPid;updatedAt=$s.updatedAt;workers=@($s.workers|ForEach-Object {$_.role+':'+$_.pid+':'+$_.state})}});nodeProcesses=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|ForEach-Object {[string]$_.ProcessId+' '+[string]$_.CommandLine.Substring([Math]::Max(0,[string]$_.CommandLine.Length-70))});cleanupProgress=$p;supervisorEvents=$ev;ocr=$ocr}|ConvertTo-Json -Compress -Depth 4`);}
catch(e){windows={error:e.code??e.name,stderr:e.diagnostics?.stderrText};}
console.log(JSON.stringify({at:new Date().toISOString(),claims,cleanup,health:{at:health.at,pid:health.pid,canStart:health.canStart,reasons:health.reasons,windows:health.windows},windows},null,1));
