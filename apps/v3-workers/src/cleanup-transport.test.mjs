import {test} from 'node:test';
import assert from 'node:assert/strict';
import {powershellCommand} from './windows-powershell.mjs';
import {needsWindowsModelStop} from './amazon-queue-recovery.mjs';
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
