// Manually launched alongside the durable queue. No boot/login installation.
import fs from 'node:fs';
import os from 'node:os';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
import {inspectClosedBatchPermits,recoverClosedBatchPermits} from './amazon-queue-recovery.mjs';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const config=read(process.argv[2]),{root,out,healthFile,connectionFile,windowsSsh}=config;
const exec=promisify(execFile),stop=new AbortController();
process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());
fs.mkdirSync(out,{recursive:true,mode:0o700});
const publish=value=>{fs.writeFileSync(healthFile+'.next',JSON.stringify({codec:'amazon-queue-health/1',at:new Date().toISOString(),pid:process.pid,...value}),{mode:0o600});fs.renameSync(healthFile+'.next',healthFile);};
const report=value=>console.log(JSON.stringify({at:new Date().toISOString(),...value}));
const ps=source=>JSON.parse(execFileSync('/usr/bin/ssh',[...windowsSsh,'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '+Buffer.from("$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop'; & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))",'utf16le').toString('base64')],{input:source,encoding:'utf8',timeout:55000,maxBuffer:3000000}));
const ticks=()=>os.cpus().reduce((a,c)=>({idle:a.idle+c.times.idle,total:a.total+Object.values(c.times).reduce((x,y)=>x+y,0)}),{idle:0,total:0});
let previous=ticks(),miniHighSince=null,windowsHighSince=null,swapSamples=[],connection,db,lastRecovery=null;
publish({canStart:false,reasons:['STARTING']});
try {
  const initial=read(root+'/live/deployment.json');
  db=new pg.Pool({connectionString:initial.database.connectionString,max:3,statement_timeout:30000,connectionTimeoutMillis:5000});
  db.on('error',()=>report({event:'HEALTH_DATABASE_UNAVAILABLE'}));
  while(!stop.signal.aborted){
    try{
      if(!connection){const c=read(connectionFile),t=c.transport;connection=await Connection.connect({address:c.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:fs.readFileSync(t.caFile),clientCertPair:{crt:fs.readFileSync(t.certFile),key:fs.readFileSync(t.keyFile)}}});}
      const client=new Client({connection,namespace:config.namespace}),m=read(root+'/live/deployment.json');
      const state={entries:(await db.query("SELECT request_id AS \"requestId\",'ACTIVE' AS state FROM amazon_queue_item WHERE state='running'")).rows};
      const recovery=await connection.withDeadline(Date.now()+30000,()=>inspectClosedBatchPermits({db,client,state}));
      if(recovery.pause)publish({canStart:false,reasons:['FAILED_EXECUTION_CLEANUP'],recovery:{recover:recovery.recover,reason:recovery.reason}});
      if(recovery.recover){
        report({event:'FAILED_EXECUTION_CLEANUP_STARTED',permits:recovery.permits.length});
        lastRecovery=await recoverClosedBatchPermits({snapshot:recovery,db,client,root,out,m,ps});
        report({event:'FAILED_EXECUTIONS_RECLAIMED',...lastRecovery});
        continue;
      }
      const now=Date.now(),current=ticks(),delta=current.total-previous.total;
      const mini={cpuPercent:delta?100*(1-(current.idle-previous.idle)/delta):0};previous=current;
      mini.memoryFreePercent=Number(/free percentage:\s*(\d+)%/.exec((await exec('/usr/bin/memory_pressure',['-Q'],{timeout:5000})).stdout)?.[1]??NaN);
      mini.swapMiB=Number(/used\s*=\s*([\d.]+)M/.exec((await exec('/usr/sbin/sysctl',['vm.swapusage'],{timeout:5000})).stdout)?.[1]??NaN);
      swapSamples.push({at:now,swap:mini.swapMiB});while(swapSamples.length>1&&swapSamples[1].at<now-60000)swapSamples.shift();
      mini.swapMinuteGrowthMiB=mini.swapMiB-swapSamples[0].swap;
      const windows=ps(String.raw`$mem=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
$cpu=Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
$s=Get-Content 'D:\crawlv3-cloud\private\cloud-status.json' -Raw|ConvertFrom-Json
[pscustomobject]@{availableGiB=([double]$mem.AvailableMBytes/1024);cpuPercent=[double]$cpu.PercentProcessorTime;running=@($s.workers|Where-Object {$_.state -eq 'running'}).Count;stopping=[bool]$s.stopping;at=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`);
      miniHighSince=mini.cpuPercent>75?(miniHighSince??now):null;
      windowsHighSince=windows.cpuPercent>75?(windowsHighSince??now):null;
      const reasons=[];
      if(!Number.isFinite(mini.memoryFreePercent)||!Number.isFinite(mini.swapMiB)||!Number.isFinite(windows.availableGiB)||!Number.isFinite(windows.cpuPercent))reasons.push('TELEMETRY_INVALID');
      if(mini.memoryFreePercent<25)reasons.push('MINI_MEMORY');
      if(windows.availableGiB<8)reasons.push('WINDOWS_MEMORY');
      if(mini.swapMinuteGrowthMiB>512)reasons.push('MINI_SWAP_GROWTH');
      if((miniHighSince&&now-miniHighSince>=30000)||(windowsHighSince&&now-windowsHighSince>=30000))reasons.push('SUSTAINED_CPU');
      if(windows.running!==2||windows.stopping)reasons.push('WINDOWS_WORKERS');
      const fleet=read(root+'/status.json');
      if(Date.now()-Date.parse(fleet.at)>25000||fleet.jobs.filter(j=>j.ready).length!==m.jobs.length||!fleet.dependencies.every(d=>d.healthy))reasons.push('FLEET_HEALTH');
      const capacities=(await db.query('SELECT healthy,health_until FROM resource_capacity WHERE resource_id=ANY($1)',[m.resources.map(r=>r.resourceId)])).rows;
      if(capacities.length!==m.resources.length||!capacities.every(r=>r.healthy&&Date.parse(r.health_until)>Date.now()))reasons.push('RESOURCE_HEALTH');
      if(fs.existsSync(root+'/MIGRATION_HOLD')||(await db.query("SELECT to_regclass('public.v3_restore_hold') IS NOT NULL held")).rows[0].held)reasons.push('MIGRATION_HOLD');
      if(recovery.pause)reasons.push('FAILED_EXECUTION_CLEANUP');
      const value={canStart:reasons.length===0,reasons,mini,windows,lastRecovery};publish(value);report({event:'QUEUE_HEALTH',...value});
    }catch(e){publish({canStart:false,reasons:['HEALTH_OR_RECOVERY_UNAVAILABLE'],error:e.code??e.name});report({event:'QUEUE_HEALTH_FAILED',code:e.code??e.name});}
    await delay(10000,undefined,{signal:stop.signal}).catch(e=>{if(!stop.signal.aborted)throw e;});
  }
} finally {publish({canStart:false,reasons:['MONITOR_STOPPED']});await connection?.close();await db?.end();}
