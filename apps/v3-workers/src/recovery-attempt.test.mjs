import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {recoverOnce} from './recovery-attempt.mjs';

const permits=[{request:{permitId:'failed-execution-1'}}];
test('a stop error remains blocked across fresh monitor calls and changed batches',async t=>{
 const out=fs.mkdtempSync(os.tmpdir()+'/recovery-once-');t.after(()=>fs.rmSync(out,{recursive:true,force:true}));let stops=0;
 const run=async()=>{stops++;throw Object.assign(Error('private stderr'),{code:'STOP_UNCONFIRMED'});};
 for(let i=0;i<5;i++)assert.equal((await recoverOnce({out,permits,run})).status,'blocked');
 assert.equal((await recoverOnce({out,permits:[...permits,{request:{permitId:'another'}}],run})).status,'blocked');
 assert.equal(stops,1);assert.doesNotMatch(fs.readFileSync(out+'/recovery-attempts/'+fs.readdirSync(out+'/recovery-attempts')[0],'utf8'),/private stderr/);
});
test('an interrupted monitor claim never starts another cleanup',async t=>{
 const out=fs.mkdtempSync(os.tmpdir()+'/recovery-crash-');t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
 fs.mkdirSync(out+'/recovery-attempts');fs.writeFileSync(out+'/recovery-attempts/'+createHash('sha256').update(permits[0].request.permitId).digest('hex')+'.json',JSON.stringify({status:'started',id:'previous-process'}));
 let calls=0;assert.equal((await recoverOnce({out,permits,run:async()=>{calls++;}})).status,'blocked');assert.equal(calls,0);
});
test('concurrent monitors invoke the stop only once, including after successful release',async t=>{
 const out=fs.mkdtempSync(os.tmpdir()+'/recovery-race-');t.after(()=>fs.rmSync(out,{recursive:true,force:true}));let calls=0,finish;
 const waiting=new Promise(resolve=>{finish=resolve;});
 const one=recoverOnce({out,permits,run:async()=>{calls++;await waiting;return {released:1};}});
 const two=await recoverOnce({out,permits,run:async()=>{calls++;}});assert.equal(two.status,'blocked');finish();assert.equal((await one).status,'completed');
 assert.equal((await recoverOnce({out,permits,run:async()=>{calls++;}})).status,'blocked');assert.equal(calls,1);
});
