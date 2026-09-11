// Independent lightweight dispatcher; no browser/model activity while waiting.
// Demo mode consumes a synthetic response only, never calls Codex.
import {readFile, writeFile} from 'node:fs/promises';
import {hostname} from 'node:os';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {HumanConfirmationClient, loadApprovalConfig} from './human-confirmation-client.mjs';
import assert from 'node:assert/strict';

assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const [mode, path, ...extra] = process.argv.slice(2);
assert.equal(extra.length,0);
assert.ok(['--demo','--report'].includes(mode));
assert.match(path ?? '', /^\/Users\/barry\/apps\/crawlv3-(?:human-confirm|local-cua)\.[a-zA-Z0-9]+\/[a-zA-Z0-9_-]+\.json$/);
const data = JSON.parse(await readFile(path,'utf8'));
const approval = mode === '--demo' ? data : data.approval;
assert.ok(approval?.id);
const client = new HumanConfirmationClient(await loadApprovalConfig(process.env.APPROVAL_CONFIG_PATH));
const deadline = Math.min(approval.expiresAt, Date.now()+600000);
console.log(JSON.stringify({event:'WAITING_FOR_HUMAN',id:approval.id,mode,expiresAt:deadline}));
let completed = false;
while (Date.now() < deadline) {
  let record;
  try { record = await client.get(approval.id); }
  catch { console.log(JSON.stringify({event:'COMMUNICATION_RETRY'})); await delay(5000); continue; }
  if (['expired','rejected','consumed'].includes(record.status)) {
    console.log(JSON.stringify({event:'STOPPED',status:record.status})); completed = true; break;
  }
  if (record.status === 'approved') {
    if (mode === '--demo') {
      assert.equal(record.action,'通信测试：仅回传回复，不操作浏览器');
      assert.equal(record.threadId, 'demo-no-codex-session');
      const receipt = await client.consume(record.id,approval);
      await writeFile(path+'.received.json',JSON.stringify({id:receipt.id,status:'REPLY_RECEIVED',reply:receipt.reply,
        at:new Date().toISOString(),browserActions:0,codexInvocations:0},null,2),{mode:0o600,flag:'wx'});
      console.log(JSON.stringify({event:'REPLY_RECEIVED',id:receipt.id,browserActions:0,codexInvocations:0}));
    } else {
      const child = spawn(process.execPath,[new URL('./mini-resume-human-confirmation.mjs',import.meta.url).pathname,path],{stdio:'inherit'});
      const code = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
      if (code !== 0) process.exitCode = 1;
    }
    completed = true; break;
  }
  await delay(5000);
}
if (!completed) console.log(JSON.stringify({event:'EXPIRED_NO_ACTION'}));
