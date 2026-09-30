// Adds the collection API (API + delivery runner, no web pages) to Server 一's deployment as job `collection-api`,
// running from this release clone and reusing the former brand-web private config (port, delivery settings).
// User 2026-09-29: "we always want use the API ... just create the API". brand-web stays removed.
// Usage (from the release's apps/v3-workers): node scripts/add-collection-api-20260929.mjs [--write]
// Then start it alone: node ~/apps/crawler-v3/manual-control.mjs start collection-api
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root='/Users/server/apps/crawler-v3',manifestPath=root+'/live/deployment.json';
const config=root+'/manual-releases/local-temporal-20260923/config-52-web.private.json';
const entry=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist/ocr-cloud/api/collection-api.js');
for(const f of [entry,path.dirname(entry)+'/migrations',config])if(!fs.existsSync(f))throw Error('Missing '+f+(f===entry?' (build first: npx tsx scripts/build-ocr-cloud.ts)':''));
const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
if(m.jobs.some(j=>j.id==='brand-web'))throw Error('brand-web is still in the deployment; both would run a delivery runner on the same port');
const job={id:'collection-api',entry,env:{V3_COLLECTION_API_CONFIG:config}},prior=m.jobs.find(j=>j.id===job.id);
if(prior&&JSON.stringify(prior)===JSON.stringify(job)){console.log(JSON.stringify({added:false,already:true,job}));process.exit(0);}
if(prior)throw Error('A different collection-api job exists: '+JSON.stringify(prior));
if(!process.argv.includes('--write')){console.log(JSON.stringify({dryRun:true,job,jobsAfter:m.jobs.length+1}));process.exit(0);}
const backup=path.join(root,'manual-releases',`deployment.before-collection-api-${Date.now()}.json`);
fs.copyFileSync(manifestPath,backup,fs.constants.COPYFILE_EXCL);
m.jobs.push(job);fs.writeFileSync(manifestPath+'.next',JSON.stringify(m,null,2),{mode:0o600});fs.renameSync(manifestPath+'.next',manifestPath);
console.log(JSON.stringify({added:true,job,backup,jobsAfter:m.jobs.length,next:`node ${root}/manual-control.mjs start collection-api`}));
