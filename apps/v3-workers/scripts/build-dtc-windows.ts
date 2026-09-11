import{build}from'tsdown';import{bundleWorkflowCode}from'@temporalio/worker';import{writeFile,mkdir,cp,readFile}from'node:fs/promises';import{resolve}from'node:path';
const common={config:false as const,format:'esm' as const,noExternal:[/^@crawl-automation\/v3-/],external:[/^@temporalio\//,'zod','pg','vitest','@aws-sdk/client-s3']};
await build({...common,entry:Object.fromEntries(['dtc-browser-worker','dtc-live-worker','channel-label-worker','channel-plan-worker','product-workflow-worker','dtc-node','dtc-prepare','dtc-recover','deployment-supervisor'].map(n=>[n,`src/${n}.ts`])),outDir:'dist/dtc-windows'});
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
await writeFile('dist/dtc-windows/product-workflows.cjs',(await bundleWorkflowCode({workflowsPath:resolve('src/product-workflows.ts')})).code);
await build({...common,entry:Object.fromEntries([
 ['dtc-node-control','integration/dtc-node-control.test.ts'],['cdp-task-pages','../../packages/v3-acquisition/src/cdp-task-pages.test.ts'],['dtc-cdp','../../packages/v3-channels/src/dtc-cdp.test.ts'],['dtc-live','../../packages/v3-channels/src/dtc-live.test.ts'],['dtc-catalog-workflow','../../packages/v3-product/src/dtc-catalog-workflow.test.ts'],
 ['amazon-live','../../packages/v3-channels/src/amazon-live.test.ts'],['amazon-catalog-workflow','../../packages/v3-product/src/amazon-catalog-workflow.test.ts'],['swanson-live','../../packages/v3-channels/src/swanson-live.test.ts'],['catalog-workflow','../../packages/v3-product/src/catalog-workflow.test.ts'],['channel-stream','integration/channel-stream.test.ts'],['dtc-stream','integration/dtc-stream.test.ts'],['cdp-wire','../../packages/v3-acquisition/src/cdp-wire.test.ts'],['cdp-file','../../packages/v3-acquisition/src/cdp-file.test.ts'],['ego-task-pages','../../packages/v3-acquisition/src/ego-task-pages.test.ts']
].map(([name,path])=>[name+'.test',path!])),outDir:'dist/dtc-windows-tests'});
// Native Temporal dependencies must be installed on the destination, never copied from macOS.
const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
const installed=(name:string)=>JSON.parse(require('node:fs').readFileSync(require.resolve(name+'/package.json'),'utf8')).version;
await writeFile('dist/dtc-windows/package.json',JSON.stringify({name:'crawlv3-dtc-node',version:'0.1.0',private:true,type:'module',engines:{node:'>=22.16 <25'},dependencies:Object.fromEntries(['@temporalio/worker','@temporalio/client','@temporalio/activity','@temporalio/common','pg','zod','@aws-sdk/client-s3'].map(n=>[n,installed(n)]))},null,2));
await cp('dtc-settings.example.json','dist/dtc-windows/settings.example.json');
await cp('DTC_WINDOWS.md','dist/dtc-windows/README.md');

await cp('dist/dtc-windows/product-workflows.cjs','dist/dtc-windows-tests/product-workflows.cjs');
