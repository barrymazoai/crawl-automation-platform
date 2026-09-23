import {test} from 'node:test';
import assert from 'node:assert/strict';
import {powershellCommand} from './windows-powershell.mjs';
import {needsWindowsModelStop} from './amazon-queue-recovery.mjs';
test('complete multiline PowerShell travels in the encoded command without stdin EOF',()=>{
 const source="$dir='D:\\test'\n[pscustomobject]@{ok=$true}|ConvertTo-Json -Compress";
 const c=powershellCommand(source),decoded=Buffer.from(c.split(' ').at(-1),'base64').toString('utf16le');
 assert.ok(decoded.endsWith(source));assert.ok(!decoded.includes('ReadToEnd'));
 assert.throws(()=>powershellCommand('x'.repeat(15000)),/COMMAND_LIMIT/);
});
test('Mini execution does not recycle unrelated Windows models; unknown/Windows execution still does',()=>{
 assert.equal(needsWindowsModelStop([{name:'interpretImage',identities:['us-mini-amazon-channel-label-vision/channel-label-vision/id/build']}]),false);
 assert.equal(needsWindowsModelStop([{name:'interpretText',identities:['windows/text/id/build']}]),true);
 assert.equal(needsWindowsModelStop([{name:'interpretImage',identities:[]}]),true);
 assert.equal(needsWindowsModelStop([{name:'ocrFile',identities:[]}]),false);
});
