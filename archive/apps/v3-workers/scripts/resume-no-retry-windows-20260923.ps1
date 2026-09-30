param([switch]$Activate)
$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop'
if(!$Activate){throw 'Explicit manual continuation required'}
$root='D:\crawlv3-cloud';$out=$root+'\logs\no-retry-20260923-verified-start'
if(Test-Path $out){throw 'Manual start already recorded'}
$s=Get-Content ($root+'\private\cloud-status.json') -Raw|ConvertFrom-Json
$lock=Get-Content ($root+'\private\cloud-supervisor.lock') -Raw|ConvertFrom-Json
if($s.supervisorPid -ne 9508 -or $s.sessionId -ne $lock.sessionId -or $s.stopping){throw 'Current supervisor changed'}
if(@($s.workers|Where-Object {$_.role -eq 'vision' -and $_.state -eq 'blocked_startup'}).Count -ne 1){throw 'Expected blocked Vision'}
$ids=@([int]$s.supervisorPid)+@($s.workers|Where-Object {$null -ne $_.pid}|ForEach-Object {[int]$_.pid})
$all=@(Get-CimInstance Win32_Process)
$children=@($all|Where-Object {$ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId})
if(@($children|Where-Object {$_.Name -ne 'conhost.exe' -or $_.ExecutablePath -ine ($env:SystemRoot+'\System32\conhost.exe')}).Count){throw 'Business child active'}
$ids+=@($children|ForEach-Object {[int]$_.ProcessId})
if(@($all|Where-Object {$ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId}).Count){throw 'Unknown descendant'}
if(Test-Path ($root+'\private\STOP-cloud')){throw 'Existing stop marker'}
New-Item -ItemType Directory $out|Out-Null
[pscustomobject]@{at=(Get-Date).ToUniversalTime().ToString('o');reason='Manual deployment continuation after independent Vision and Temporal preflights passed';oldPids=$ids;oldSession=$s.sessionId;buildId=$s.buildId}|ConvertTo-Json -Depth 4|Set-Content ($out+'\intent.json') -Encoding UTF8
Set-Content ($root+'\private\STOP-cloud') 'no-retry-verified-start-20260923' -Encoding ASCII
$until=(Get-Date).AddSeconds(40)
do{$alive=@(Get-Process -Id $ids -ErrorAction SilentlyContinue);if(!$alive.Count){break};Start-Sleep -Milliseconds 250}while((Get-Date)-lt $until)
if($alive.Count -or (Test-Path ($root+'\private\cloud-supervisor.lock'))){throw 'Old owner stop unconfirmed'}
if([IO.File]::ReadAllText($root+'\private\STOP-cloud').Trim() -ne 'no-retry-verified-start-20260923'){throw 'Marker owner changed'}
Remove-Item ($root+'\private\STOP-cloud')
$p=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe '+$root+'\cloud-supervisor.mjs '+$out)}
if($p.ReturnValue -ne 0){throw 'Manual start failed'}
$until=(Get-Date).AddSeconds(60)
do{
 $n=Get-Content ($root+'\private\cloud-status.json') -Raw|ConvertFrom-Json
 $ready=$n.sessionId -ne $s.sessionId -and $n.buildId -eq $s.buildId -and !$n.stopping -and @($n.workers|Where-Object {$_.state -eq 'running'}).Count -eq 2
 if($ready){break}
 if(@($n.workers|Where-Object {$_.state -eq 'blocked_startup'}).Count -gt 0 -and $n.sessionId -ne $s.sessionId){break}
 Start-Sleep -Seconds 1
}while((Get-Date)-lt $until)
[pscustomobject]@{ready=$ready;supervisorPid=$n.supervisorPid;buildId=$n.buildId;workers=$n.workers;oldProcessesAbsent=$true}|ConvertTo-Json -Depth 4 -Compress
if(!$ready){throw 'Manual deployment start not ready; no repeat'}
