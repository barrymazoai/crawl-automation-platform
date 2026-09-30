import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {replaceFileWithRetry,sleepSync} from './status-file.mjs';

// Temporary directories are left for the OS to reclaim; tests issue no deletes.
const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),'status-file-'));
test('a transient EPERM from a concurrent reader is retried and the status still lands',()=>{
 const dir=scratch(),target=path.join(dir,'status.json'),temporary=target+'.1.tmp';fs.writeFileSync(temporary,'{"n":1}');
 let failures=3,slept=0;
 const io={renameSync(a,b){if(failures-->0){const e=Error('EPERM: operation not permitted, rename');e.code='EPERM';throw e;}fs.renameSync(a,b);},sleepSync:()=>{slept++;}};
 assert.deepEqual(replaceFileWithRetry(io,temporary,target),{replaced:true,attempts:4});
 assert.equal(fs.readFileSync(target,'utf8'),'{"n":1}');assert.equal(slept,3);assert.ok(!fs.existsSync(temporary));
});
test('a persistent lock is reported, the old status survives and nothing is thrown',()=>{
 const dir=scratch(),target=path.join(dir,'status.json'),temporary=target+'.2.tmp';fs.writeFileSync(target,'old');fs.writeFileSync(temporary,'new');
 const io={renameSync(){const e=Error('EBUSY');e.code='EBUSY';throw e;},sleepSync:()=>{}};
 assert.deepEqual(replaceFileWithRetry(io,temporary,target,{attempts:3}),{replaced:false,attempts:3,code:'EBUSY'});
 assert.equal(fs.readFileSync(target,'utf8'),'old');
});
test('non-lock errors still propagate',()=>{
 const io={renameSync(){const e=Error('ENOENT');e.code='ENOENT';throw e;},sleepSync(){}};
 assert.throws(()=>replaceFileWithRetry(io,'a','b'),/ENOENT/);
});
test('sleepSync blocks for roughly the requested time',()=>{const t=Date.now();sleepSync(20);assert.ok(Date.now()-t>=15);});
