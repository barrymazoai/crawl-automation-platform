// Points Server 一's manual-control.mjs at the health monitor built in this release clone (fix 74c16b7: the monitor
// keeps running when Workers are added or removed and exits when it stops). Only the two monitor paths change; the
// original file is backed up first. Workers are not touched. Afterwards restart the monitor alone:
//   launchctl bootout gui/$(id -u)/com.crawlv3.m.3b182ce4ee627515 && node ~/apps/crawler-v3/manual-control.mjs start all
// Usage (from the release's apps/v3-workers): node scripts/switch-monitor-20260929.mjs [--write]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root='/Users/server/apps/crawler-v3',control=path.join(root,'manual-control.mjs');
const old=path.join(root,'source/apps/v3-workers/dist/us-control/deployment-launchd.js');
const bundle=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist/ocr-cloud/us-control/deployment-launchd.js');
if(!fs.existsSync(bundle))throw Error('Build first: npx tsx scripts/build-ocr-cloud.ts ('+bundle+' missing)');
const mod=await import(pathToFileURL(bundle).href);
if(typeof mod.monitorBinding!=='function')throw Error('Bundle predates the monitor fix: '+bundle);
const text=fs.readFileSync(control,'utf8'),uses=text.split(old).length-1;
if(text.includes(bundle)&&!uses){console.log(JSON.stringify({switched:true,already:true,bundle}));process.exit(0);}
if(uses!==2)throw Error(`Expected the old monitor path twice in manual-control.mjs, found ${uses}`);
const next=text.replaceAll(old,bundle);
if(!process.argv.includes('--write')){console.log(JSON.stringify({dryRun:true,from:old,to:bundle,replacements:uses}));process.exit(0);}
const backup=path.join(root,'manual-releases',`manual-control.before-monitor-${Date.now()}.mjs`);
fs.copyFileSync(control,backup,fs.constants.COPYFILE_EXCL);fs.writeFileSync(control,next);
console.log(JSON.stringify({switched:true,from:old,to:bundle,backup,next:'launchctl bootout gui/$(id -u)/com.crawlv3.m.3b182ce4ee627515 && node '+control+' start all'}));
