import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildHumanResumePrompt,CHROME_RESUME_BOOTSTRAP,cuaInitializationStatus} from './cua-resume-prompt.mjs';
import {toolCallFromEvent} from './codex-action-confirm.mjs';
const receipt = {id:'fixture-id',threadId:'fixture-thread',url:'https://example.com/',question:'fixture question',reply:'fixture actual human reply'};
test('resume starts with new Chrome binding and keeps human reply and scope',()=>{
  const prompt = buildHumanResumePrompt(receipt);
  assert.ok(prompt.startsWith(CHROME_RESUME_BOOTSTRAP));
  assert.ok(prompt.includes('var resumedChrome = await cua.getApp("com.google.Chrome");'));
  for (const value of Object.values(receipt)) assert.ok(prompt.includes(value));
  assert.match(prompt,/本次回复只使用一次/);
  assert.match(prompt,/已变化或无法确认/);
  assert.throws(()=>buildHumanResumePrompt({...receipt,reply:''}), /MISSING_reply/);
});
test('initialization evidence distinguishes stale binding, failed init and real successful init',()=>{
  const event = code => ({type:'item.completed',item:{type:'mcp_tool_call',server:'cua_repl',tool:'js',status:'completed',arguments:{code}}});
  assert.equal(cuaInitializationStatus([toolCallFromEvent(event('await app.getAXStateAndScreenshot()'))]),'FAILED');
  const actual = toolCallFromEvent(event('var resumedChrome = await cua.getApp("com.google.Chrome");'));
  assert.equal(cuaInitializationStatus([actual]),'INITIALIZED');
  assert.equal(cuaInitializationStatus([{...actual,status:'failed'}]),'FAILED');
  assert.equal(cuaInitializationStatus([]),'NOT_OBSERVED');
});
