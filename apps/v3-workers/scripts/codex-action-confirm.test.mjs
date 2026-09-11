import {test} from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {
  isActionTimeConfirmation,
  runCodexWithActionConfirm,
} from "./codex-action-confirm.mjs";

test("detects action-time confirmation asks and ignores reports", () => {
  assert.equal(isActionTimeConfirmation("请回复：确认，让本机 Codex 提交当前 GNC 人机验证。"), true);
  assert.equal(isActionTimeConfirmation("Solve CAPTCHAs 需要 Always Confirm at Action-Time，请确认是否继续。"), true);
  assert.equal(isActionTimeConfirmation("I need you to confirm that I should click Press and Hold."), true);
  assert.equal(isActionTimeConfirmation("需要你在执行前明确确认一次：这会向 gnc.com 提交当前 CAPTCHA 验证结果。"), true);
  assert.equal(isActionTimeConfirmation("产品页未通过，页面显示请再试一次。"), false);
  assert.equal(isActionTimeConfirmation("原生 Chrome 可访问，当前为人机验证页。"), false);
  assert.equal(isActionTimeConfirmation(""), false);
});

function fakeCodex(script) {
  const runs = [];
  return {
    runs,
    spawnFn(executable, args) {
      const turn = runs.length;
      const child = new EventEmitter();
      const stdout = new PassThrough();
      child.pid = turn + 1;
      child.stdout = stdout;
      child.stderr = new PassThrough();
      runs.push({executable, args, pid: child.pid});
      queueMicrotask(() => {
        for (const event of script[turn] ?? []) stdout.write(`${JSON.stringify(event)}\n`);
        stdout.end();
        child.emit("exit", 0, null);
      });
      return child;
    },
  };
}

test("stops on confirmation; legacy maxConfirms never auto replies", async () => {
  const fake = fakeCodex([
    [
      {type: "thread.started", thread_id: "thr_confirm"},
      {type: "item.completed", item: {type: "mcp_tool_call", server: "cua_repl", tool: "js", status: "completed"}},
      {type: "item.completed", item: {type: "agent_message", text: "请确认当前按住验证。"}},
    ],
    [
      {type: "item.completed", item: {type: "agent_message", text: "已执行一次，页面显示请再试一次。"}},
    ],
  ]);
  const events = [];
  const result = await runCodexWithActionConfirm({
    prompt: "operate the current challenge",
    maxConfirms: 1,
    timeoutMs: 1000,
    detached: false,
    spawnFn: fake.spawnFn,
    onEvent: event => events.push(event),
  });
  assert.equal(result.status, "CONFIRMATION_PENDING");
  assert.equal(result.confirms, 0);
  assert.equal(result.confirmationPending, true);
  assert.equal(result.threadId, "thr_confirm");
  assert.match(result.last, /请确认/);
  assert.equal(fake.runs.length, 1);
  assert.equal(events.some(event => event.event === "LOCAL_CONTINUE"), false);
});

test("does not resume a completed report", async () => {
  const fake = fakeCodex([[
    {type: "thread.started", thread_id: "thr_done"},
    {type: "item.completed", item: {type: "agent_message", text: "产品页未通过，页面显示请再试一次。"}},
  ]]);
  const result = await runCodexWithActionConfirm({
    prompt: "report only",
    maxConfirms: 2,
    timeoutMs: 1000,
    detached: false,
    spawnFn: fake.spawnFn,
  });
  assert.equal(result.status, "DONE");
  assert.equal(result.confirms, 0);
  assert.equal(fake.runs.length, 1);
});

test("stops after the confirm budget if Codex keeps asking", async () => {
  const ask = {type: "item.completed", item: {type: "agent_message", text: "请确认当前操作。"}};
  const fake = fakeCodex([
    [{type: "thread.started", thread_id: "thr_loop"}, ask],
    [ask],
  ]);
  const result = await runCodexWithActionConfirm({
    prompt: "challenge",
    maxConfirms: 1,
    timeoutMs: 1000,
    detached: false,
    spawnFn: fake.spawnFn,
  });
  assert.equal(result.status, "CONFIRMATION_PENDING");
  assert.equal(result.confirms, 0);
  assert.equal(result.confirmationPending, true);
  assert.equal(fake.runs.length, 1);
});

test('resumes only with explicitly supplied reply in the exact thread', async () => {
  const fake = fakeCodex([[{type:'item.completed',item:{type:'agent_message',text:'模拟操作已完成'}}]]);
  const result = await runCodexWithActionConfirm({prompt:'测试用户的真实回复', resumeThreadId:'thr_human',
    spawnFn:fake.spawnFn, detached:false, timeoutMs:1000});
  assert.equal(result.status, 'DONE');
  assert.deepEqual(fake.runs[0].args.slice(-3), ['resume','thr_human','测试用户的真实回复']);
});

test('rejects configured canned confirmation text', async () => {
  await assert.rejects(runCodexWithActionConfirm({prompt:'test',confirmReply:'确认'}), /AUTOMATIC_CONFIRM_REPLY_DISABLED/);
});
