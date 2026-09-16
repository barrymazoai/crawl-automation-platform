// Mini: apply the next pending V3 migration(s) from candidate/migrations with the v3-api bootstrap protocol
// (advisory lock, sha-checked ledger, transactional file). Refuses unknown or reordered history.
//   node apply-migration.mjs <expected-last-name>     e.g. 021_submission_guard_per_request.sql
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';import {createHash} from 'node:crypto';import pg from 'pg';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const expected=process.argv[2];assert.match(expected??'',/^\d{3}_[a-z0-9_]+\.sql$/,'usage: apply-migration.mjs <name>');
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',candidate='/Users/barry/apps/crawlv3-history-20260913/ocr-cloud-20260915/candidate';
const sha=b=>createHash('sha256').update(b).digest('hex');
const m=JSON.parse(await fs.readFile(main+'/live/deployment.json','utf8'));const priv=JSON.parse(await fs.readFile(m.jobs.find(j=>j.id==='amazon-channel-label-ocr-receipts').env.V3_CHANNEL_LABEL_CONFIG,'utf8'));
const db=new pg.Pool({connectionString:priv.database.connectionString,max:1,statement_timeout:20000});
try{
 const migrations=(await fs.readdir(candidate+'/migrations')).filter(n=>/^\d{3}_.*\.sql$/.test(n)).sort();assert.equal(migrations.at(-1),expected,'candidate last migration '+migrations.at(-1));
 const applied=(await db.query('SELECT name,sha256 FROM public.v3_local_migration ORDER BY name')).rows;
 for(const [i,row] of applied.entries()){assert.equal(row.name,migrations[i]);assert.equal(row.sha256,sha(await fs.readFile(candidate+'/migrations/'+row.name)),'migration changed: '+row.name);}
 const pending=migrations.slice(applied.length);
 const c=await db.connect();try{await c.query('BEGIN');await c.query("SET LOCAL search_path=public; SET LOCAL lock_timeout='5s'");await c.query('SELECT pg_advisory_xact_lock(73110311)');
  for(const name of pending){const sql=await fs.readFile(candidate+'/migrations/'+name,'utf8');assert.ok(/^[\s\S]*?\bBEGIN;/.test(sql)&&/COMMIT;\s*$/.test(sql),'migration must be transactional: '+name);
   await c.query(sql.replace(/\bBEGIN;/,'').replace(/COMMIT;\s*$/,''));await c.query('INSERT INTO public.v3_local_migration VALUES ($1,$2)',[name,sha(Buffer.from(sql))]);}
  await c.query('COMMIT');}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 console.log(JSON.stringify({event:'MIGRATIONS_APPLIED',applied:pending,ledger:(await db.query('SELECT count(*)::int n FROM public.v3_local_migration')).rows[0].n}));
}finally{await db.end();}
