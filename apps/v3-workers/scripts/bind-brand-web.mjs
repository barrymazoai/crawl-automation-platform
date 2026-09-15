// Mini, fleet RUNNING: rebind the brand-web job to the candidate build (which knows migration 020) and restart it.
// brand-web reads `migrations/<name>` beside its bundle and refuses to start when the ledger holds a migration it
// does not list; the old release lists 19. Originals retained; manifest swap is atomic.
//   node bind-brand-web.mjs
import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {hostname} from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
const main='/Users/barry/apps/crawlv3-batch-a.UiA4dx',work='/Users/barry/apps/crawlv3-history-20260913/ocr-cloud-20260915',candidate=work+'/candidate',dest=main+'/release-throughput-20260915/web',out=work+'/rollout';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),run=promisify(execFile);
const retain=async(p,b)=>{try{await fs.writeFile(p,b,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;assert.ok((await fs.readFile(p)).equals(Buffer.from(b)),'differs: '+p);}};
await fs.mkdir(dest+'/migrations',{recursive:true,mode:0o700});
await retain(dest+'/brand-web.js',await fs.readFile(candidate+'/web/brand-web.js'));
const migrations=(await fs.readdir(candidate+'/migrations')).filter(n=>/^\d{3}_.*\.sql$/.test(n)).sort();assert.equal(migrations.at(-1),'020_product_enrichment.sql');
for(const n of migrations)await retain(dest+'/migrations/'+n,await fs.readFile(candidate+'/migrations/'+n));
const manifestPath=main+'/live/deployment.json',text=await fs.readFile(manifestPath,'utf8'),m=JSON.parse(text),job=m.jobs.find(j=>j.id==='brand-web');assert.ok(job);
await retain(out+'/deployment-before-brand-web.private.json',text);
const before=job.entry;job.entry=dest+'/brand-web.js';
await fs.writeFile(manifestPath+'.brand-web-next',JSON.stringify(m,null,2),{flag:'wx',mode:0o600});await fs.rename(manifestPath+'.brand-web-next',manifestPath);
const controller=main+'/release-independent-control-20260913/independent-deployment/deployment-launchd.js';
const r=await run('/opt/homebrew/bin/node',[controller,'restart',manifestPath,'brand-web'],{timeout:180000,maxBuffer:1048576});assert.equal(JSON.parse(r.stdout).ready[0].id,'brand-web');
const health=await read(main+'/brand-web.health.json');
const api=await fetch('http://127.0.0.1:4188/api/v3/brands',{headers:{'X-V3-Client':'local-workspace'},signal:AbortSignal.timeout(10000)});
console.log(JSON.stringify({event:'BRAND_WEB_REBOUND',from:before,to:job.entry,health,apiStatus:api.status,migrations:migrations.length}));
