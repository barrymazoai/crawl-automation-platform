import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HumanConfirmationClient} from './human-confirmation-client.mjs';

const expected = {hash:'fixture-hash',threadId:'fixture-thread',contextId:'fixture-context'};
test('client only sends creation/reading credentials and consumes matched human receipt',async()=>{
  const calls=[];
  const client = new HumanConfirmationClient({origin:'https://fixture.example',workerToken:'fixture-token'},async(url,options)=>{
    calls.push({url,options});
    return {ok:true,json:async()=>({...expected,status:calls.length===1?'approved':'consumed',expiresAt:Date.now()+100000,reply:'fixture human text'})};
  });
  assert.equal((await client.consume('fixture-id',expected)).reply,'fixture human text');
  assert.equal(calls.length,2);
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[1].options.method,'POST');
  assert.equal(calls.some(c=>c.url.includes('/human/')),false);
});
test('pending, expired, wrong-context and server errors cannot resume',async()=>{
  for (const override of [{status:'pending'},{expiresAt:1},{contextId:'different'},{threadId:'different'}]) {
    let count=0;
    const client=new HumanConfirmationClient({origin:'https://fixture.example',workerToken:'fixture'},async()=>{
      count++; return {ok:true,json:async()=>({...expected,status:'approved',expiresAt:Date.now()+100000,...override})};
    });
    await assert.rejects(client.consume('fixture',expected), /APPROVAL_/);
    assert.equal(count,1);
  }
  const client=new HumanConfirmationClient({origin:'https://fixture.example',workerToken:'fixture'},async()=>({ok:false,status:503}));
  await assert.rejects(client.get('fixture'), /HTTP_503/);
});
