import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {powershellCommand,redactControlOutput} from './windows-powershell.mjs';
import {needsWindowsModelStop,windowsStopScript} from './amazon-queue-recovery.mjs';
import {recoverOnce,reconcileOnce,claimPath} from './recovery-attempt.mjs';
test('short loader reads exact UTF-8 bytes without stdin EOF or a long command line',()=>{
 const source='#'+('x'.repeat(16000))+"\n[pscustomobject]@{ok='中文'}|ConvertTo-Json -Compress";
 const c=powershellCommand(source),decoded=Buffer.from(c.split(' ').at(-1),'base64').toString('utf16le');
 assert.ok(c.length<4000);assert.ok(!decoded.includes('ReadToEnd'));assert.ok(decoded.includes('byte[] '+Buffer.byteLength(source,'utf8')));
 assert.ok(decoded.includes('RECOVERY.SCRIPT_TRUNCATED'));assert.ok(!decoded.includes(source));
 assert.throws(()=>powershellCommand('x'.repeat(150000)),/SCRIPT_LIMIT/);
});
test('Mini execution does not recycle unrelated Windows models; unknown/Windows execution still does',()=>{
 assert.equal(needsWindowsModelStop([{name:'interpretImage',identities:['us-mini-amazon-channel-label-vision/channel-label-vision/id/build']}]),false);
 assert.equal(needsWindowsModelStop([{name:'interpretText',identities:['windows/text/id/build']}]),true);
 assert.equal(needsWindowsModelStop([{name:'interpretImage',identities:[]}]),true);
 assert.equal(needsWindowsModelStop([{name:'ocrFile',identities:[]}]),false);
});
test('the Windows stop script treats a dead owner as a stopped state with proof, never as an integrity error',()=>{
 const s=windowsStopScript({cloudDir:String.raw`D:\crawlv3-cloud\logs\failure-cleanup-x`,model:true,ocr:true,id:'11111111-2222-4333-8444-555555555555'});
 assert.ok(!s.includes("throw 'Cloud PID identity changed'"));
 assert.ok(s.includes('$proof.cloudOwnerAbsent=$true'));
 assert.ok(s.includes("$_.CommandLine -match 'cloud-supervisor\\.mjs'"),'live owner must be the supervisor script, not any node.exe holding the PID');
 assert.ok(s.includes('channel-label-worker\\.js')&&s.includes('$lock.release'),'orphaned Workers of exactly this release are stopped');
 assert.ok(s.includes("throw 'Status worker PID held by an unidentified node process'"));
 assert.ok(s.includes('$proof.ocrOwnerAbsent=$true'),'an absent OCR parent with no OCR python left is a stopped state');
 assert.ok(s.includes("throw 'OCR owner ambiguous'"),'stray OCR python without the service parent still stops the cleanup');
 assert.ok(s.includes("Set-Content 'D:\\crawlv3-cloud\\private\\STOP-cloud' '11111111-2222-4333-8444-555555555555'"),'restoration keeps its single marker-based restart path');
 assert.ok(s.includes("catch{$proof.error=$_.Exception.Message;$proof.failedStage=$proof.stage;Note 'failed';throw}"),'the failing precondition is recorded before rethrow');
 assert.ok(s.includes('$proof.absentPids=')&&!s.includes('$proof.oldPids+=@([int]$lock.pid)'),'a reused owner PID is never listed as a PID to wait on');
 const modelOnly=windowsStopScript({cloudDir:'D:\\x',model:true,ocr:false,id:'11111111-2222-4333-8444-555555555555'});
 assert.ok(modelOnly.includes('ocr=$false')&&modelOnly.includes('model=$true'));
});
test('control output kept for the operator is redacted and bounded',()=>{
 const text='At line:3 char:5 Cloud PID identity changed Authorization: Bearer abc.def token=xyz https://host/path?sig=1 '+'y'.repeat(5000);
 const r=redactControlOutput(text);
 assert.ok(r.includes('Cloud PID identity changed'));assert.ok(!r.includes('abc.def'));assert.ok(!r.includes('sig=1'));assert.ok(!r.includes('token=xyz'));
 assert.equal(r.length,4000);
});
test('reconcile runs once more only over failed claims and records the outcome on them',async()=>{
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'reconcile-'));
 const permits=[{request:{permitId:'p-1'}},{request:{permitId:'p-2'}}];
 assert.equal((await reconcileOnce({out,permits,run:async()=>{}})).reason,'RECOVERY.NO_FAILED_CLAIM');
 await recoverOnce({out,permits,run:async()=>{throw Object.assign(Error('x'),{code:'RECOVERY.WINDOWS_COMMAND_FAILED'});}});
 assert.equal(JSON.parse(fs.readFileSync(claimPath(out,'p-1'))).status,'failed');
 let runs=0;const failed=await reconcileOnce({out,permits,run:async()=>{runs++;throw Object.assign(Error('still'),{code:'STOP_UNCONFIRMED'});}});
 assert.equal(failed.status,'failed');assert.equal(JSON.parse(fs.readFileSync(claimPath(out,'p-2'))).error,'STOP_UNCONFIRMED');
 const done=await reconcileOnce({out,permits,run:async()=>{runs++;return {released:2};}});
 assert.equal(done.status,'reconciled');assert.equal(runs,2);
 const claim=JSON.parse(fs.readFileSync(claimPath(out,'p-1')));assert.equal(claim.status,'reconciled');assert.deepEqual(claim.previous.map(p=>p.error),['STOP_UNCONFIRMED','STOP_UNCONFIRMED']);
 assert.equal((await reconcileOnce({out,permits,run:async()=>{runs++;}})).status,'reconciled');assert.equal(runs,3);
 fs.writeFileSync(claimPath(out,'p-1'),JSON.stringify({id:'live',status:'started'}));
 assert.equal((await reconcileOnce({out,permits,run:async()=>{runs++;}})).reason,'RECOVERY.CLAIM_ACTIVE');assert.equal(runs,3);
 assert.equal((await recoverOnce({out,permits,run:async()=>{runs++;}})).status,'blocked','the automatic path still never repeats a cleanup');
});
