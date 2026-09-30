// Read-only CUA observation of the owned loopback pointer fixture.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {hostname} from 'node:os';
import {runCodexWithActionConfirm} from './codex-action-confirm.mjs';
import {CUA_MODEL,CUA_EFFORT,cuaCodexArgs} from './cua-model.mjs';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const [url,...extra]=process.argv.slice(2);
assert.equal(extra.length,0);
assert.match(url??'',/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+\/$/);
const root=await mkdtemp('/Users/barry/apps/crawlv3-pointer-observe.');
console.log(JSON.stringify({root,model:CUA_MODEL,effort:CUA_EFFORT}));
const result=await runCodexWithActionConfirm({
  prompt:`只读观察 Mac mini 当前唯一 Chrome 中的自建鼠标测试页 ${url}，标题 CUA Pointer Lab — 本机鼠标测试。这不是验证码。不导航、不点击、不移动鼠标、不修改任何设置。第一条工具调用只能 var app = await cua.getApp("com.google.Chrome"); 阅读返回的工具文档，读取当前 AX 和截图，核对自建页面。如果不是指定页面立即停止。请务必获取当前窗口截图，用来确定绿色测试区域的位置。报告页面已经记录的按住毫秒数、按下前轨迹及当前鼠标是否松开；没有记录就说尚未测量。不要访问其他窗口，不使用 shell/CDP/JS 代替 CUA，不进行任何鼠标动作。`,
  ...cuaCodexArgs(root,{ephemeral:true}),timeoutMs:120000,
  logPath:`${root}/events.jsonl`,errPath:`${root}/stderr.log`,
  onEvent:event=>console.log(JSON.stringify(event)),
});
const report={root,model:CUA_MODEL,effort:CUA_EFFORT,code:result.code,last:result.last,calls:result.calls,at:new Date().toISOString()};
await writeFile(`${root}/report.json`,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify(report));
