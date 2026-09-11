// Synthetic approvals only. These tests never contact Codex, GNC, or the live service.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApprovalStore} from '../src/store.mjs';
import {approvalServer} from '../src/server.mjs';

const input = {requestKey:'test-request-0001',workerId:'fixture-worker',taskId:'fixture-task',threadId:'fixture-thread',
  url:'https://example.com/',action:'TEST ONLY',question:'Fixture asks permission',contextId:'fixture-context'};

test('idempotency, immutable binding, expiry, rejection and one-use receipt', () => {
  let now = 1000; const store = new ApprovalStore(':memory:', () => now);
  try {
    const a = store.create(input);
    assert.equal(a.status,'pending');
    assert.equal(store.create(input).id,a.id);
    assert.throws(() => store.create({...input,threadId:'other'}), /IDEMPOTENCY_CONFLICT/);
    assert.throws(() => store.consume(a.id,a.hash), /NOT_APPROVED/);
    assert.throws(() => store.decide(a.id,'wrong','approved','fixture'), /BINDING_CHANGED/);
    assert.throws(() => store.decide(a.id,a.hash,'approved',''), /REPLY_REQUIRED/);
    store.decide(a.id,a.hash,'approved','fixture human response');
    assert.equal(store.consume(a.id,a.hash).reply,'fixture human response');
    assert.throws(() => store.consume(a.id,a.hash), /ALREADY_CONSUMED/);
    const b = store.create({...input,requestKey:'test-request-0002'});
    store.decide(b.id,b.hash,'rejected','fixture rejection');
    assert.throws(() => store.consume(b.id,b.hash), /NOT_APPROVED/);
    const c = store.create({...input,requestKey:'test-request-0003',ttlMs:1000});
    now += 1001;
    assert.equal(store.get(c.id).status,'expired');
    assert.throws(() => store.decide(c.id,c.hash,'approved','too late'), /NOT_PENDING/);
  } finally { store.close(); }
});

test('pending and human decisions survive database reopen; approved can expire', () => {
  const path = join(mkdtempSync(join(tmpdir(),'approval-test-')),'state.sqlite');
  let now = 1000;
  let store = new ApprovalStore(path, () => now);
  const a = store.create({...input,ttlMs:1000}); store.close();
  store = new ApprovalStore(path, () => now);
  assert.equal(store.get(a.id).status,'pending');
  store.decide(a.id,a.hash,'approved','fixture response'); store.close();
  store = new ApprovalStore(path, () => now);
  assert.equal(store.get(a.id).reply,'fixture response');
  now += 1001;
  assert.throws(() => store.consume(a.id,a.hash), /NOT_APPROVED/);
  assert.equal(store.get(a.id).status,'expired'); store.close();
});

test('HTTP roles, auth, CSRF, no approval on GET, no duplicate consumption', async () => {
  const store = new ApprovalStore(':memory:');
  const workerToken = 'w'.repeat(48), password = 'p'.repeat(48);
  const origin = 'https://confirm.example.com';
  const server = approvalServer({store,workerToken,password,username:'tester',origin});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const worker = {Authorization:`Bearer ${workerToken}`,'Content-Type':'application/json'};
  const human = {Authorization:'Basic '+Buffer.from(`tester:${password}`).toString('base64'),'Content-Type':'application/json'};
  const post = (path, headers, body) => fetch(url+path,{method:'POST',headers,body:JSON.stringify(body)});
  try {
    assert.equal((await fetch(url+'/healthz')).status,200);
    assert.equal((await fetch(url+'/')).status,401);
    assert.equal((await fetch(url+'/human/requests',{headers:worker})).status,401);
    assert.equal((await post('/worker/requests',human,input)).status,401);
    const a = await (await post('/worker/requests',worker,input)).json();
    const page = await fetch(url+'/',{headers:human});
    assert.equal(page.status,200); assert.match(await page.text(),/打开页面、刷新或等待都不会批准/);
    assert.equal(store.get(a.id).status,'pending');
    const list = await (await fetch(url+'/human/requests',{headers:human})).json();
    const endpoint = `/human/requests/${a.id}/decision`;
    const body = {hash:a.hash,decision:'approved',reply:'fixture-only reply'};
    assert.equal((await post(endpoint,worker,body)).status,401);
    assert.equal((await post(endpoint,{...human,Origin:origin},body)).status,403);
    assert.equal((await post(endpoint,{...human,Origin:'https://evil.example','X-CSRF-Token':list.items[0].csrf},body)).status,403);
    assert.equal((await post(endpoint,{...human,Origin:origin,'X-CSRF-Token':list.items[0].csrf},body)).status,200);
    const results = await Promise.all([1,2].map(() => post(`/worker/requests/${a.id}/consume`,worker,{hash:a.hash})));
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  } finally { await new Promise(resolve=>server.close(resolve)); store.close(); }
});
