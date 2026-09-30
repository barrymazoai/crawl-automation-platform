import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CUA_MODEL,CUA_EFFORT,cuaCodexArgs} from './cua-model.mjs';
test('Computer Use uses explicit Astra low with unchanged permissions',()=>{
  assert.equal(CUA_MODEL,'gpt-6-astra'); assert.equal(CUA_EFFORT,'low');
  const args=cuaCodexArgs('/fixture');
  assert.ok(args.prefixArgs.includes('model_reasoning_effort="low"'));
  assert.deepEqual(args.prefixArgs.slice(0,4),['-a','never','-s','read-only']);
  assert.equal(args.execArgs[args.execArgs.indexOf('-m')+1],'gpt-6-astra');
  assert.ok(!args.execArgs.includes('--ephemeral'));
  assert.ok(cuaCodexArgs('/fixture',{ephemeral:true}).execArgs.includes('--ephemeral'));
});
