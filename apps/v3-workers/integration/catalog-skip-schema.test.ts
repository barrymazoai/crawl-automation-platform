import {expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrationNames} from '../../v3-api/src/bootstrap/schema.js';
import {PostgresDashboard} from '../../v3-api/src/storage/postgres-dashboard.js';

it.skipIf(process.env.V3_SKIP_SCHEMA_TEST!=='1')('fresh isolated database separates skips from Review and prevents mutation',async()=>{
 const exec=promisify(execFile),docker='/opt/homebrew/bin/docker',dir=await mkdtemp(join(tmpdir(),'dtc-skip-schema-'));
 const name='dtc-skip-test-'+randomUUID().slice(0,8),password=randomUUID(),envFile=join(dir,'postgres.env');
 await writeFile(envFile,`POSTGRES_USER=tester\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=crawler_v3_test\n`,{mode:0o600});
 let db:pg.Pool|undefined,started=false;
 try{
  await exec(docker,['run','-d','--name',name,'--env-file',envFile,'--publish','127.0.0.1::5432','postgres:18']);started=true;
  const port=Number((await exec(docker,['port',name,'5432/tcp'])).stdout.trim().split(':').at(-1));
  db=new pg.Pool({host:'127.0.0.1',port,user:'tester',password,database:'crawler_v3_test',connectionTimeoutMillis:1000});
  for(let i=0;;i++){try{await db.query('SELECT 1');break;}catch(e){if(i>=60)throw e;await new Promise(r=>setTimeout(r,250));}}
  const migrationRoot=process.env.V3_MIGRATIONS_ROOT;if(!migrationRoot)throw Error('Isolated migration directory required');
  for(const name of migrationNames)await db.query(await readFile(join(migrationRoot,name),'utf8'));
  await db.query("INSERT INTO catalog_run(catalog_id,scope,scope_hash) VALUES('catalog','{}','hash')");
  await db.query("INSERT INTO catalog_discovery(discovery_id,catalog_id,listing_id,variant_key,record,first_page) VALUES('discovery','catalog','bundle','','{}',0)");
  const record={receipt:{status:'skipped',reason:'bundle_or_pack'}};
  await db.query('INSERT INTO catalog_product_skip(discovery_id,record,record_hash) VALUES($1,$2,$3)',['discovery',record,'a'.repeat(64)]);
  const summary=await new PostgresDashboard(db).summary();expect(summary.skippedProducts).toBe(1);expect(summary.reviews).toBe(0);expect(summary.collectedProducts).toBe(0);
  await expect(db.query("UPDATE catalog_product_skip SET record='{}'")).rejects.toThrow('immutable');
  await expect(db.query('DELETE FROM catalog_product_skip')).rejects.toThrow('immutable');
  expect((await db.query('SELECT count(*)::int AS n FROM catalog_product_skip')).rows[0].n).toBe(1);
 }finally{await db?.end();if(started)await exec(docker,['rm','-f',name]);}
},60000);
