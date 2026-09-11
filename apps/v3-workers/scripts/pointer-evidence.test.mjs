import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarizePointerEvidence} from './pointer-evidence.mjs';
test('short clicks and repeated drags are not accumulated into one hold',()=>{
  const s=summarizePointerEvidence({down:false,strokes:[{durationMs:1500,trusted:true},{durationMs:1500,trusted:true}]});
  assert.equal(s.continuousHoldObserved,false); assert.equal(s.maxHoldMs,1500); assert.equal(s.buttonReleased,true);
});
test('untrusted or unfinished pointer activity cannot pass hold measurement',()=>{
  const s=summarizePointerEvidence({down:true,strokes:[{durationMs:4000,trusted:false}]});
  assert.equal(s.continuousHoldObserved,false); assert.equal(s.buttonReleased,false);
});
test('one real continuous long stroke is measured',()=>{
  const s=summarizePointerEvidence({down:false,strokes:[{durationMs:2100,trusted:true,moves:5}]});
  assert.equal(s.continuousHoldObserved,true); assert.equal(s.buttonReleased,true);
});
test('ten-second target requires a single stroke of at least ten seconds',()=>{
  const evidence=strokes=>({down:false,strokes:strokes.map(durationMs=>({durationMs,trusted:true}))});
  assert.equal(summarizePointerEvidence(evidence([2000,8000,9999]),10000).continuousHoldObserved,false);
  assert.equal(summarizePointerEvidence(evidence([10000]),10000).continuousHoldObserved,true);
});
