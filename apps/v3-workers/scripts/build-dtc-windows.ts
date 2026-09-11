import { portableWorkflowBundle } from './workflow-source-map.js';
import{build}from'tsdown';import{bundleWorkflowCode}from'@temporalio/worker';import{writeFile,mkdir,cp,readFile}from'node:fs/promises';import{resolve,join}from'node:path';import{readdir}from'node:fs/promises';import{createHash}from'node:crypto';
const common={config:false as const,format:'esm' as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,'zod','pg','vitest','@aws-sdk/client-s3']};
await build({...common,entry:Object.fromEntries(['dtc-browser-worker','dtc-live-worker','channel-label-worker','channel-plan-worker','product-workflow-worker','dtc-node','dtc-prepare','dtc-recover','deployment-supervisor'].map(n=>[n,`src/${n}.ts`])),outDir:'dist/dtc-windows'});
// Pinned legacy Skill is runtime code. Normalize text bytes across Git Windows/macOS
// and bind their hashes into a root JS artifact covered by the existing build ID.
const skillFiles:Record<string,string>={};
async function copySkill(relative:string){
 const source=resolve('../../crawl-products',relative);
 const entries=await readdir(source,{withFileTypes:true});
 for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
  const path=relative+'/'+entry.name;
  if(entry.isDirectory())await copySkill(path);
  else if(!/\.test\./.test(entry.name)&&/\.(mjs|js|json|md)$/.test(entry.name))await saveSkill(path);
 }
}
async function saveSkill(path:string){const bytes=Buffer.from((await readFile(resolve('../../crawl-products',path),'utf8')).replaceAll('\r\n','\n'));await mkdir(resolve('dist/dtc-windows/crawl-products',path,'..'),{recursive:true});await writeFile(resolve('dist/dtc-windows/crawl-products',path),bytes);skillFiles[path]=createHash('sha256').update(bytes).digest('hex');}
await saveSkill('SKILL.md');await copySkill('lib');await copySkill('references');
await writeFile('dist/dtc-windows/dtc-skill-integrity.js','export default '+JSON.stringify(Object.fromEntries(Object.entries(skillFiles).sort(([a],[b])=>a<b?-1:1)))+';\n');
// Assert the emitted Windows import graph cannot load a PostgreSQL client or a Mini Worker.
const checked=new Set<string>();
async function browserGraph(file:string){
 if(checked.has(file))return;checked.add(file);const code=await readFile(file,'utf8');
 for(const match of code.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g)){
  const spec=match[1]!;if(spec==='pg'||spec.includes('dtc-live-worker')||spec.includes('dtc-mini-node'))throw Error('DTC.WINDOWS_DATABASE_IMPORT');
  if(spec.startsWith('.'))await browserGraph(resolve(file,'..',spec));
 }
}
for(const entry of ['dtc-browser-worker','dtc-node','dtc-recover'])await browserGraph(resolve('dist/dtc-windows',entry+'.js'));
const workflowBundle=portableWorkflowBundle((await bundleWorkflowCode({workflowsPath:resolve('src/product-workflows.ts')})).code);
await writeFile('dist/dtc-windows/product-workflows.cjs',workflowBundle.code);
// Offline TypeScript debugging aid; never loaded by the Worker or counted as executable code.
await writeFile('dist/dtc-windows/product-workflows.compiler.map',workflowBundle.compilerSourceMap);
await build({...common,entry:Object.fromEntries([
 ['dtc-legacy-evidence','integration/dtc-legacy-evidence.test.ts'],['dtc-node-control','integration/dtc-node-control.test.ts'],['cdp-task-pages','../../packages/v3-acquisition/src/cdp-task-pages.test.ts'],['dtc-cdp','../../packages/v3-channels/src/dtc-cdp.test.ts'],['dtc-live','../../packages/v3-channels/src/dtc-live.test.ts'],['dtc-catalog-workflow','../../packages/v3-product/src/dtc-catalog-workflow.test.ts'],
 ['amazon-live','../../packages/v3-channels/src/amazon-live.test.ts'],['amazon-catalog-workflow','../../packages/v3-product/src/amazon-catalog-workflow.test.ts'],['swanson-live','../../packages/v3-channels/src/swanson-live.test.ts'],['catalog-workflow','../../packages/v3-product/src/catalog-workflow.test.ts'],['channel-stream','integration/channel-stream.test.ts'],['dtc-stream','integration/dtc-stream.test.ts'],['cdp-wire','../../packages/v3-acquisition/src/cdp-wire.test.ts'],['cdp-file','../../packages/v3-acquisition/src/cdp-file.test.ts'],['ego-task-pages','../../packages/v3-acquisition/src/ego-task-pages.test.ts']
].map(([name,path])=>[name+'.test',path!])),outDir:'dist/dtc-windows-tests'});
// Native Temporal dependencies must be installed on the destination, never copied from macOS.
const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
const installed=(name:string)=>JSON.parse(require('node:fs').readFileSync(require.resolve(name+'/package.json'),'utf8')).version;
await writeFile('dist/dtc-windows/package.json',JSON.stringify({name:'crawlv3-dtc-node',version:'0.1.0',private:true,type:'module',engines:{node:'>=22.16 <25'},dependencies:Object.fromEntries(['@temporalio/worker','@temporalio/client','@temporalio/activity','@temporalio/common','pg','zod','@aws-sdk/client-s3'].map(n=>[n,installed(n)]).concat([['playwright-core',JSON.parse(await readFile(resolve('../../crawl-products/node_modules/playwright-core/package.json'),'utf8')).version]]))},null,2));
await cp('dtc-settings.example.json','dist/dtc-windows/settings.example.json');
await cp('DTC_WINDOWS.md','dist/dtc-windows/README.md');

await cp('dist/dtc-windows/product-workflows.cjs','dist/dtc-windows-tests/product-workflows.cjs');
