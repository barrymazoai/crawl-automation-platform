param([switch]$Activate)
$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop'
if(!$Activate){throw 'Explicit activation switch required'}
$root='D:\crawlv3-cloud';$relative='releases/no-retry-20260923b/source/apps/v3-workers/dist/cloud-workers'
$release=$root+'\'+$relative.Replace('/','\');$out=$root+'\logs\no-retry-20260923'
if(Test-Path $out){throw 'Activation already attempted; reconcile before another action'}
$build=[IO.File]::ReadAllText($release+'\BUILD_ID').Trim();if($build -notmatch '^[a-f0-9]{64}$'){throw 'Invalid candidate build'}
$status=Get-Content ($root+'\private\cloud-status.json') -Raw|ConvertFrom-Json
$lock=Get-Content ($root+'\private\cloud-supervisor.lock') -Raw|ConvertFrom-Json
if($status.supervisorPid -ne $lock.pid -or $status.sessionId -ne $lock.sessionId -or $status.stopping){throw 'Supervisor identity changed'}
if(@($status.workers|Where-Object {$_.state -eq 'running'}).Count -ne 2){throw 'Expected two idle model workers'}
$all=@(Get-CimInstance Win32_Process);$ids=@([int]$lock.pid)+@($status.workers|ForEach-Object {[int]$_.pid})
if(@($all|Where-Object {$ids -contains [int]$_.ProcessId -and $_.Name -eq 'node.exe'}).Count -ne 3){throw 'Worker process identities changed'}
if(@($all|Where-Object {$ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId}).Count){throw 'Worker children remain; do not interrupt model work'}
if(Test-Path ($root+'\private\STOP-cloud')){throw 'Existing stop marker'}
New-Item -ItemType Directory $out|Out-Null
$status|ConvertTo-Json -Depth 8|Set-Content ($out+'\before.json') -Encoding UTF8
Copy-Item ($root+'\cloud-supervisor.mjs') ($out+'\cloud-supervisor.before.mjs')
foreach($role in @('text','vision')){Copy-Item ($root+'\private\channel-label-'+$role+'.runtime.json') ($out+'\'+$role+'.before.private.json')}
Set-Content ($root+'\private\STOP-cloud') 'no-retry-20260923' -Encoding ASCII
$until=(Get-Date).AddSeconds(40)
do{$remaining=@(Get-Process -Id $ids -ErrorAction SilentlyContinue);if(!$remaining.Count){break};Start-Sleep -Milliseconds 250}while((Get-Date)-lt $until)
if($remaining.Count){throw 'Stop unconfirmed; no second stop request'}
if(Test-Path ($root+'\private\cloud-supervisor.lock')){throw 'Old supervisor did not finish its own cleanup'}
$encoding=New-Object System.Text.UTF8Encoding($false)
foreach($role in @('text','vision')){
 $file=$root+'\private\channel-label-'+$role+'.runtime.json';$c=Get-Content $file -Raw|ConvertFrom-Json
 if($c.concurrency -ne 4){throw 'Unexpected current model concurrency'}
 $c.expectedBuildId=$build;[IO.File]::WriteAllText($file,($c|ConvertTo-Json -Depth 15),$encoding)
}
$file=$root+'\cloud-supervisor.mjs';$code=[IO.File]::ReadAllText($file)
if(!$code.Contains('releases/promises-20260922/source/apps/v3-workers/dist/cloud-workers')){throw 'Unexpected supervisor release binding'}
$code=$code.Replace('releases/promises-20260922/source/apps/v3-workers/dist/cloud-workers',$relative)
[IO.File]::WriteAllText($file,$code,$encoding)
if([IO.File]::ReadAllText($root+'\private\STOP-cloud').Trim() -ne 'no-retry-20260923'){throw 'Stop marker changed'}
Remove-Item ($root+'\private\STOP-cloud')
$created=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe '+$file+' '+$out)}
if($created.ReturnValue -ne 0){throw 'One-shot supervisor start failed'}
$until=(Get-Date).AddSeconds(60);$ready=$false
do{
 $s=Get-Content ($root+'\private\cloud-status.json') -Raw|ConvertFrom-Json
 $ready=$s.buildId -eq $build -and $s.sessionId -ne $status.sessionId -and !$s.stopping -and @($s.workers|Where-Object {$_.state -eq 'running'}).Count -eq 2
 if($ready){break};Start-Sleep -Seconds 1
}while((Get-Date)-lt $until)
if(!$ready){throw 'New workers not ready; do not retry activation'}
[pscustomobject]@{at=(Get-Date).ToUniversalTime().ToString('o');buildId=$build;workers=$s.workers;textConcurrency=4;visionConcurrency=4;ocrChanged=$false;bootOrLoginInstalled=$false}|ConvertTo-Json -Depth 5 -Compress
