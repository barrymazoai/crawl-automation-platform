import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetainedPublication, sha256 } from '@crawl-automation/v3-artifacts';
import { TextLocalStore } from '@crawl-automation/v3-text';
import { parseDtcRenderedProduct } from '@crawl-automation/v3-channels';
import { legacyScopeSkip, legacyProductProjection, DtcLegacyFileTransport } from '../src/dtc-legacy-evidence.js';
let root:string,publication:RetainedPublication;
const signal=()=>AbortSignal.timeout(10000),url='https://shop.example.com/products/a?variant=2',imageUrl='https://shop.example.com/cdn/a.jpg';
const site:any={origin:'https://shop.example.com',brandName:'Example',productPathPrefix:'/products/',imageOrigins:['https://shop.example.com']};
const raw=()=>[{productUrl:'https://shop.example.com/products/a',fields:{title:'A',sku:'default-sku',description:'Description',price:'28.00',custom:'preserve'},variants:[{variantId:'1',sku:'sku-1',price:'28.00'},{variantId:'2',sku:'sku-2',price:'67.00',options:{Supply:'3 months'}}],gallery:[{url:imageUrl,localPath:'evidence/img/a.jpg',mime:'image/jpeg'}],pageHtml:'evidence/html/a.html',coverage:{gallerySaved:'1/1'},flags:[]}];
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'legacy-evidence-'));await mkdir(join(root,'capture/evidence/img'),{recursive:true});await mkdir(join(root,'capture/evidence/html'),{recursive:true});await writeFile(join(root,'capture/evidence/img/a.jpg'),Buffer.from([255,216,255,217]));await writeFile(join(root,'capture/evidence/html/a.html'),'<main><h1>A</h1><table><tr><td>Supplement Facts</td><td>12 mg</td></tr></table></main>');await writeFile(join(root,'capture/evidence/records.json'),JSON.stringify(raw()));publication=new RetainedPublication(await TextLocalStore.open(join(root,'local'),32*1024*1024),await TextLocalStore.open(join(root,'remote'),32*1024*1024));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
it('retains the old full record, HTML, all variants and exact original bytes; file handoff works after capture files disappear',async()=>{
 const p=await legacyProductProjection(join(root,'capture'),'v3/dtc-legacy/op',url,site,publication,signal());
 expect(p.legacy?.fields.custom).toBe('preserve');expect(p.legacy?.variants).toHaveLength(2);expect(p.legacy?.selectedVariant?.sku).toBe('sku-2');
 const parsed=parseDtcRenderedProduct(p,url,{listingId:p.listingId,variantId:null});expect(parsed.detailsHtml).toContain('<table>');
 const m=JSON.parse(Buffer.from((await publication.remote.read(p.legacy!.manifestKey,65536,signal()))!).toString());
 const original=m.files.find((f:any)=>f.path==='evidence/records.json');expect(JSON.parse(Buffer.from((await publication.remote.read(original.objectKey,65536,signal()))!).toString())).toEqual(raw());
 await rm(join(root,'capture'),{recursive:true});
 const response=await new DtcLegacyFileTransport(publication,'op',url,imageUrl,'test').get(new URL(imageUrl),undefined,{},signal());const chunks=[];for await(const b of response.body)chunks.push(b);response.close();expect(sha256(Buffer.concat(chunks))).toBe(m.images[0].sha256);
});
it.each(['missing-image','path-escape','wrong-variant','wrong-product','missing-html'])('refuses incomplete or mismatched legacy evidence: %s',async(mode)=>{
 const r=raw();if(mode==='missing-image')r[0]!.gallery[0]!.localPath='evidence/img/missing.jpg';if(mode==='path-escape')r[0]!.gallery[0]!.localPath='../outside.jpg';if(mode==='wrong-variant')r[0]!.variants=[];if(mode==='wrong-product')r[0]!.productUrl='https://elsewhere.example/products/a';if(mode==='missing-html')r[0]!.pageHtml='missing.html';await writeFile(join(root,'capture/evidence/records.json'),JSON.stringify(r));await expect(legacyProductProjection(join(root,'capture'),'v3/dtc-legacy/op',url,site,publication,signal())).rejects.toThrow();
});
it('rejects symlink evidence rather than reading outside task output',async()=>{await symlink(join(root,'remote'),join(root,'capture/outside'));await expect(legacyProductProjection(join(root,'capture'),'v3/dtc-legacy/op',url,site,publication,signal())).rejects.toThrow('DTC.EVIDENCE_PATH');});
it('write context records a missing target without creating it and refuses escaped or linked paths',async()=>{
 const {dtcWriteContext}=await import('../src/dtc-write-context.js'),{access}=await import('node:fs/promises');
 const target=join(root,'capture','run-catalog.mjs'),context=await dtcWriteContext(root,target);
 expect(context.entries.at(-1)).toMatchObject({path:target,status:'ENOENT'});await expect(access(target)).rejects.toThrow();
 await expect(dtcWriteContext(root,join(root,'..','outside'))).rejects.toThrow('DTC.DIAGNOSTIC_PATH_OUTSIDE_TASK');
 await symlink(join(root,'remote'),join(root,'capture','linked'));
 const linked=await dtcWriteContext(root,join(root,'capture','linked','anything'));
 expect(linked.entries.at(-2)?.status).toBe('symlink_not_followed');expect(linked.entries.at(-1)?.status).toBe('not_inspected_after_path_boundary');
});
it('refuses a file URL not in this captured product',async()=>{await legacyProductProjection(join(root,'capture'),'v3/dtc-legacy/op',url,site,publication,signal());await expect(new DtcLegacyFileTransport(publication,'op',url,imageUrl,'test').get(new URL(imageUrl+'?other'),undefined,{},signal())).rejects.toThrow('SOURCE.SESSION_MISMATCH');});

it('retains an original larger than the text evidence default limit',async()=>{await writeFile(join(root,'capture/evidence/img/a.jpg'),Buffer.alloc(9*1024*1024,7));const p=await legacyProductProjection(join(root,'capture'),'v3/dtc-legacy/large',url,site,publication,signal());expect(p.images).toEqual([imageUrl]);});

it.each(['catalog','product'] as const)('keeps %s script and its diagnostics at Runner root while publishing only capture evidence',async mode=>{
 const {DtcLegacyCapture}=await import('../src/dtc-legacy-capture.js'),{cp}=await import('node:fs/promises');
 const scriptName=mode==='catalog'?'run-catalog.mjs':'run-capture.mjs',script='// task-owned temporary script\n';let scriptPath='';
 const config={settings:{provider:'openai',model:'gpt-5.6-luna',reasoningEffort:'medium'},executable:'/test/codex',codexHome:join(root,'auth'),workRoot:join(root,'work'),runtimeProfileVersion:'test/1',timeoutMs:10000};
 const capture=new DtcLegacyCapture(config,{},root,options=>({run:async input=>{
  scriptPath=options!.env!.CRAWL_WORKER_SCRIPT_PATH!;
  expect(scriptPath).toBe(join(input.cwd,scriptName));
  expect(input.prompt).toContain(`任务目录：${input.cwd}\n`);
  await writeFile(scriptPath,script,{flag:'wx'});
  if(mode==='product')await cp(join(root,'capture'),join(input.cwd,'capture'),{recursive:true});
  else{
   await writeFile(join(input.cwd,'capture/catalog.json'),JSON.stringify({entries:[{url,title:'A'}],navigation:[]}));
   await writeFile(join(input.cwd,'capture/catalog.html'),'<main><a href="'+url+'">A</a></main>');
   await writeFile(join(input.cwd,'capture/screenshot.png'),Buffer.from([137,80,78,71,13,10,26,10]));
  }
  return{status:'complete',summary:'fixture',reasonCode:null};
 }}));
 await capture.capture({page:{taskId:'test',targetId:'TARGET',config:{endpoint:'http://127.0.0.1:9222/',instanceId:'instance',pauseFile:join(root,'pause')}},operationId:'root-script-'+mode,url,mode,site,publication,port:{guard:async()=>{},list:async()=>[],create:async()=>'',close:async()=>{},call:async()=>null},authorize:async()=>{},finishBrowser:async()=>{}},signal());
 const key='v3/dtc-legacy/root-script-'+mode,readRemote=async(name:string)=>JSON.parse(Buffer.from((await publication.remote.read(key+'/'+name,65536,signal()))!).toString());
 const diagnostic=await readRemote('write-diagnostic.json');
 expect(diagnostic.writeContexts[0].context.entries.at(-1)).toMatchObject({path:scriptPath,status:'ENOENT'});
 expect(diagnostic.writeContexts[1].context.entries.at(-1)).toMatchObject({path:scriptPath,status:'exists',bytes:Buffer.byteLength(script)});
 const manifest=await readRemote(mode==='catalog'?'catalog-manifest.json':'manifest.json');
 expect(manifest.files.length).toBeGreaterThan(0);expect(manifest.files.some((f:any)=>f.path.endsWith('.mjs'))).toBe(false);
});

it.each(['complete','needs_review','failed','cancelled','user-control'])('host finishes browser before publication for %s; user control remains pending',async(status)=>{
 const {DtcLegacyCapture}=await import('../src/dtc-legacy-capture.js');const {cp,access}=await import('node:fs/promises');
 const events:string[]=[];let taskFile='';
 const config={settings:{provider:'openai',model:'gpt-5.6-luna',reasoningEffort:'medium'},executable:'/test/codex',codexHome:join(root,'auth'),workRoot:join(root,'work'),runtimeProfileVersion:'test/1',timeoutMs:10000};
 const capture=new DtcLegacyCapture(config,{PATH:'/test',DATABASE_URL:'do-not-pass',R2_SECRET:'do-not-pass'},root,options=>({run:async input=>{
  expect(options?.env?.DATABASE_URL).toBeUndefined();expect(options?.env?.R2_SECRET).toBeUndefined();expect(options?.inheritEnv).toBe(false);taskFile=options!.env!.CRAWL_BROWSER_TASK_FILE!;
  expect(options?.env?.CRAWL_WORKER_PRODUCT_URL).toBe(url);
  await cp(join(root,'capture'),join(input.cwd,'capture'),{recursive:true});
  if(status==='user-control')throw Error('SOURCE.BROWSER_USER_CONTROL');if(status==='cancelled')throw Error('codex_aborted');
  return{status,summary:'test',reasonCode:null};
 }}));
 const publish=publication.publish.bind(publication);publication.publish=async(...args)=>{events.push('publish');return publish(...args);};
 const pending=capture.capture({page:{taskId:'test',targetId:'TARGET',config:{endpoint:'http://127.0.0.1:9222/',instanceId:'instance',pauseFile:join(root,'pause')}},operationId:'op',url,mode:'product',site,publication,port:{guard:async()=>{},list:async()=>[],create:async()=>'',close:async()=>{},call:async()=>null},authorize:async()=>{},finishBrowser:async()=>{events.push('close');}},signal());
 if(status==='complete')await pending;else await expect(pending).rejects.toThrow();
 if(status==='user-control')expect(events).not.toContain('close');else expect(events[0]).toBe('close');
 await expect(access(taskFile)).rejects.toThrow();
});

it('scope skip requires exact retained harvest exclusion and empty records, then records a separate idempotent outcome',async()=>{
 const {dtcFixture}=await import('../../../packages/v3-channels/src/dtc-live.fixture.js'),{recordDtcScopeSkip}=await import('../src/dtc-scope-skip.js');
 const job=await dtcFixture().job(),target=job.discovery.entry.url,key=`v3/dtc-legacy/${job.operationId}`;
 await writeFile(join(root,'capture/evidence/records.json'),'[]');await writeFile(join(root,'capture/harvest-result.json'),JSON.stringify({excluded:[{url:target,reason:'bundle_or_pack'}],failed:[]}));
 const receipt=await legacyScopeSkip(join(root,'capture'),key,job.operationId,target,publication,signal());let saved:any;const sqls:string[]=[];
 const db={query:async(sql:string,args?:unknown[])=>{sqls.push(sql);if(sql.startsWith('INSERT'))saved??={record:args![1],record_hash:args![2]};return{rows:saved?[saved]:[]};}};
 expect(await recordDtcScopeSkip({job,receipt},publication.remote,db,signal())).toEqual(receipt);expect(await recordDtcScopeSkip({job,receipt},publication.remote,db,signal())).toEqual(receipt);
 expect(sqls.every(sql=>sql.includes('catalog_product_skip'))).toBe(true);
 await expect(recordDtcScopeSkip({job,receipt:{...receipt,evidenceSha256:'0'.repeat(64)}},publication.remote,db,signal())).rejects.toThrow('UNVERIFIED');
});
it.each(['foreign-url','nonempty-records','missing-harvest','different-reason'])('scope skip rejects %s rather than trusting model summary',async mode=>{
 await writeFile(join(root,'capture/evidence/records.json'),mode==='nonempty-records'?JSON.stringify(raw()):'[]');
 if(mode!=='missing-harvest')await writeFile(join(root,'capture/harvest-result.json'),JSON.stringify({excluded:[{url:mode==='foreign-url'?'https://other.example/product':url,reason:mode==='different-reason'?'unknown':'bundle_or_pack'}],failed:[]}));
 await expect(legacyScopeSkip(join(root,'capture'),'v3/dtc-legacy/op','op',url,publication,signal())).rejects.toThrow();
});
