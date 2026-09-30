// No polling loop inside a business Worker. Invoke only for a known pending report.
import {readFile, writeFile, mkdtemp} from 'node:fs/promises';
import {hostname} from 'node:os';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {HumanConfirmationClient, loadApprovalConfig, approvalContext} from './human-confirmation-client.mjs';
import {runCodexWithActionConfirm} from './codex-action-confirm.mjs';
import {buildHumanResumePrompt,cuaInitializationStatus} from './cua-resume-prompt.mjs';
import {CUA_MODEL,CUA_EFFORT,cuaCodexArgs} from './cua-model.mjs';

assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
const [reportPath, ...extra] = process.argv.slice(2);
assert.equal(extra.length,0);
assert.match(reportPath ?? '', /^\/Users\/barry\/apps\/crawlv3-local-cua\.[a-zA-Z0-9]+\/report.json$/);
const previous = JSON.parse(await readFile(reportPath, 'utf8'));
assert.equal(previous.status,'CONFIRMATION_PENDING');
const approval = previous.approval;
assert.ok(approval?.id);
assert.match(approval.sessionRoot, /^\/Users\/barry\/apps\/crawlv3-gnc-pool\.[a-zA-Z0-9]+\/live$/);
const target = JSON.parse(await readFile(`${approval.sessionRoot}/report.json`,'utf8'));
assert.equal(target.accessPreparation?.status,'waiting');
assert.equal(target.status,'preparing');
assert.ok(!target.laneReleased && !target.laneProcessesStopped && !target.code,'SESSION_ALREADY_TERMINAL');
assert.equal(target.submittedWorkflows,0);
assert.equal(target.lane?.headless,false);
assert.equal(approvalContext(target),approval.contextId);
assert.ok(Number.isSafeInteger(target.lane.browserPid));
const command = execFileSync('/bin/ps',['-p',String(target.lane.browserPid),'-o','command='],{encoding:'utf8'});
assert.ok(command.includes('Google Chrome.app/Contents/MacOS/Google Chrome'));
assert.ok(command.includes(`--user-data-dir=${target.lane.profilePath}`));
const client = new HumanConfirmationClient(await loadApprovalConfig(process.env.APPROVAL_CONFIG_PATH));
const record = await client.get(approval.id);
if (record.status !== 'approved') {
  console.log(JSON.stringify({status:record.status,approvalId:record.id,resumed:false}));
  process.exit(0);
}
const root = await mkdtemp('/Users/barry/apps/crawlv3-local-cua.');
// Consume before sending: at-most-once. If this process crashes, do NOT replay approval.
const receipt = await client.consume(approval.id,approval);
await writeFile(`${root}/human-receipt.json`,JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
const prompt = buildHumanResumePrompt(receipt);
const result = await runCodexWithActionConfirm({prompt,resumeThreadId:receipt.threadId,timeoutMs:180000,
  ...cuaCodexArgs(previous.root),
  logPath:`${root}/events.jsonl`,errPath:`${root}/stderr.log`});
const initialization = cuaInitializationStatus(result.calls);
const report = {root,status:initialization !== 'INITIALIZED' && result.status === 'DONE' ? 'CUA_REINITIALIZATION_FAILED' : result.status,
  initialization,model:CUA_MODEL,effort:CUA_EFFORT,threadId:result.threadId,last:result.last,calls:result.calls,
  code:result.code,signal:result.signal,timedOut:result.timedOut,receiptId:receipt.id,at:new Date().toISOString()};
await writeFile(`${root}/report.json`,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify(report));
