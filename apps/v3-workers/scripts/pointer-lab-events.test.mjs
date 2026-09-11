// Pure fixture tests with fake events. These do not prove OS input or CAPTCHA success.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {summarizePointerEvidence} from './pointer-evidence.mjs';
const source=readFileSync(new URL('./cua-pointer-lab.html',import.meta.url),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function lab(){
  const listeners={},pad={setPointerCapture(){}},elements={pad,state:{},results:{}};
  let evidence;
  runInNewContext(source,{document:{getElementById:id=>elements[id],addEventListener:(type,fn)=>listeners[type]=fn},
    fetch:(_url,options)=>{evidence=JSON.parse(options.body);return Promise.resolve();},
    location:{pathname:'/fixture/'},setInterval(){},performance:{now:()=>0}});
  return {send(type,t,x,y,overrides={}){listeners[type]({type,timeStamp:t,clientX:x,clientY:y,
    target:pad,pointerId:1,button:0,buttons:type==='pointerdown'?1:0,isTrusted:true,...overrides});},
    read:()=>evidence};
}
test('records a pre-press route independently of hold movement',()=>{
  const p=lab();p.send('pointermove',0,10,10);p.send('pointermove',100,40,50);
  p.send('pointerdown',200,40,50);p.send('pointerup',10200,40,50);
  const s=p.read().strokes[0];assert.equal(s.prePress.distancePx,50);assert.equal(s.prePress.eventCount,2);
  assert.equal(s.moves,0);assert.equal(s.durationMs,10000);
  assert.equal(summarizePointerEvidence(p.read()).prePressMovementObserved,true);
});
test('same coordinate events are not evidence of movement',()=>{
  const p=lab();p.send('pointermove',0,10,10);p.send('pointermove',100,10,10);
  p.send('pointerdown',200,10,10);p.send('pointerup',10200,10,10);
  assert.equal(summarizePointerEvidence(p.read()).prePressMovementObserved,false);
});
test('old and previously used paths are excluded from next stroke',()=>{
  const p=lab();p.send('pointermove',0,10,10);p.send('pointermove',100,100,100);
  p.send('pointerdown',6000,100,100);p.send('pointerup',16000,100,100);
  assert.equal(p.read().strokes[0].prePress.eventCount,0);
  p.send('pointerdown',17000,100,100);p.send('pointerup',27000,100,100);
  assert.equal(p.read().strokes[1].prePress.eventCount,0);
});
test('synthetic paths do not qualify as trusted movement',()=>{
  const p=lab();p.send('pointermove',0,10,10,{isTrusted:false});p.send('pointermove',100,100,100);
  p.send('pointerdown',200,100,100);p.send('pointerup',10200,100,100);
  assert.equal(summarizePointerEvidence(p.read()).prePressMovementObserved,false);
});
test('evidence remains under gateway size limit after many events and strokes',()=>{
  const p=lab();for(let n=0;n<50;n++){
    for(let i=0;i<300;i++)p.send('pointermove',n*15000+i*10,i,i);
    p.send('pointerdown',n*15000+3000,300,300);p.send('pointerup',n*15000+13000,300,300);
  }
  assert.equal(p.read().strokes.length,10);assert.ok(JSON.stringify(p.read()).length<50000);
  assert.ok(p.read().strokes.every(s=>s.prePress.samples.length<=24));
});
