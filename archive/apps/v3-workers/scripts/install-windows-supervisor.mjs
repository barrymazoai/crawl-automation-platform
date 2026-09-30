// One-shot operator step, run on Server 1: copy the versioned Windows supervisor
// (deploy/windows/cloud-supervisor.mjs + status-file.mjs) to D:\crawlv3-cloud,
// keeping a backup of the file it replaces, verifying hashes and syntax. It never
// starts the supervisor and refuses to touch a running one.
//   node install-windows-supervisor.mjs [health.private.json] [release source dir]
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const [healthConfig='/Users/server/apps/crawler-v3/manual-releases/local-temporal-20260923/health.private.json',
  source='/Users/server/apps/crawler-v3/releases/fleet-20260924/source']=process.argv.slice(2);
const h=JSON.parse(fs.readFileSync(healthConfig,'utf8'));
const {runWindowsPowerShell}=await import(source+'/apps/v3-workers/src/windows-powershell.mjs');
const dir=source+'/apps/v3-workers/deploy/windows/';
const local=Object.fromEntries(['cloud-supervisor.mjs','status-file.mjs'].map(f=>[f,fs.readFileSync(dir+f)]));
const expected=Object.fromEntries(Object.entries(local).map(([f,b])=>[f,createHash('sha256').update(b).digest('hex')]));
const script=String.raw`
$root='D:\crawlv3-cloud';$log=$root+'\logs\fleet-20260924';New-Item -ItemType Directory -Force $log|Out-Null
if(Test-Path 'D:\crawlv3-cloud\private\STOP-cloud'){throw 'STOP marker present'}
if(@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object {$_.CommandLine -match 'cloud-supervisor\.mjs'}).Count){throw 'A supervisor is running; not replacing its script'}
if(!(Test-Path ($log+'\cloud-supervisor.before.mjs'))){Copy-Item ($root+'\cloud-supervisor.mjs') ($log+'\cloud-supervisor.before.mjs')}
[IO.File]::WriteAllBytes($root+'\cloud-supervisor.mjs',[Convert]::FromBase64String('${local['cloud-supervisor.mjs'].toString('base64')}'))
[IO.File]::WriteAllBytes($root+'\status-file.mjs',[Convert]::FromBase64String('${local['status-file.mjs'].toString('base64')}'))
$r=[ordered]@{}
foreach($f in @('cloud-supervisor.mjs','status-file.mjs','logs\fleet-20260924\cloud-supervisor.before.mjs')){$r[$f]=(Get-FileHash ($root+'\'+$f) -Algorithm SHA256).Hash.ToLower()}
$check=& 'D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe' --check ($root+'\cloud-supervisor.mjs') 2>&1
$r['nodeCheckExit']=$LASTEXITCODE;$r['nodeCheckOutput']=[string]$check
[pscustomobject]$r|ConvertTo-Json -Compress`;
const result=runWindowsPowerShell(h.windowsSsh,script);
const ok=Object.entries(expected).every(([f,sha])=>result[f]===sha)&&result.nodeCheckExit===0;
console.log(JSON.stringify({at:new Date().toISOString(),expected,result,verified:ok}));
if(!ok){process.exitCode=1;}
