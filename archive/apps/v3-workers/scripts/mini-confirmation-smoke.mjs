import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {HumanConfirmationClient,loadApprovalConfig} from './human-confirmation-client.mjs';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const [output,...extra] = process.argv.slice(2);
assert.equal(extra.length,0);
assert.match(output??'',/^\/Users\/barry\/apps\/crawlv3-human-confirm\.[a-zA-Z0-9]+\/demo-[a-zA-Z0-9_-]+\.json$/);
const client = new HumanConfirmationClient(await loadApprovalConfig(process.env.APPROVAL_CONFIG_PATH));
const record = await client.create({requestKey:randomUUID(),workerId:hostname(),taskId:'confirmation-communication-smoke',
  threadId:'demo-no-codex-session',contextId:randomUUID(),url:'https://example.com/',
  action:'通信测试：仅回传回复，不操作浏览器',question:'请在下方输入一条测试回复并点击确认。Mac mini 只保存这条回复，不启动 Codex、不操作验证码、不提交爬虫任务。',ttlMs:600000});
await writeFile(output,JSON.stringify(record,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({id:record.id,status:record.status,url:`${client.config.origin}/#${record.id}`,expiresAt:record.expiresAt}));
