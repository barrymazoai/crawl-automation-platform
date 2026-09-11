import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { portableWorkflowBundle } from './workflow-source-map.js';
const marker='//# sourceMappingURL=data:application/json;charset=utf-8;base64,';
const executable='var value = 1;\nvar escaped = "\\r\\n";\nvoid value;\n';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function bundle(code=executable,map:Record<string,unknown>={}){
 return code+marker+Buffer.from(JSON.stringify({version:3,file:'machine-specific.js',sources:['/Users/builder/repo/workflow.ts'],sourcesContent:['source'],mappings:'AAAA',names:[],...map})).toString('base64')+'\n';
}
test('three Windows CRLFs and arbitrary compiler-map differences converge to one exact runtime artifact',()=>{
 const mac=portableWorkflowBundle(bundle());
 const windows=portableWorkflowBundle(bundle(executable.replaceAll('\n','\r\n'),{
  file:'windows-hash.js',sourceRoot:'D:\\repo',sources:['D:\\repo\\workflow.ts','webpack/bootstrap'],
  sourcesContent:['different virtual entrypoint','different compiler text'],mappings:'AACA;AAAA',names:['different'],
 }));
 assert.equal(windows.code,mac.code);
 assert.notEqual(windows.compilerSourceMap,mac.compilerSourceMap);
 assert.equal(mac.code.slice(0,mac.code.indexOf(marker)),executable);
 assert.equal(portableWorkflowBundle(mac.code).code,mac.code);
});
test('actual executable changes still change the fully checked artifact',()=>{
 assert.notEqual(sha(portableWorkflowBundle(bundle()).code),sha(portableWorkflowBundle(bundle(executable.replace('value = 1','value = 2'))).code));
});
test('runtime map resolves actual stack positions to the normalized generated source',async()=>{
 const output=portableWorkflowBundle(bundle()).code;
 const map=JSON.parse(Buffer.from(output.slice(output.indexOf(marker)+marker.length).trim(),'base64').toString());
 assert.deepEqual(map.sources,['product-workflows.generated.js']);assert.deepEqual(map.sourcesContent,[executable]);
 const localRequire=createRequire(import.meta.url),sdkRequire=createRequire(localRequire.resolve('@temporalio/worker'));
 const {SourceMapConsumer}=sdkRequire('source-map');
 const consumer=await new SourceMapConsumer(map);
 try{for(const line of [1,2,3])assert.deepEqual(consumer.originalPositionFor({line,column:5}),{source:'product-workflows.generated.js',line,column:0,name:null});}finally{consumer.destroy();}
});
test('missing or malformed map and unsupported lone CR stop the build',()=>{
 assert.throws(()=>portableWorkflowBundle(executable),/SOURCE_MAP_MISSING/);
 assert.throws(()=>portableWorkflowBundle(bundle(executable,{version:2})),/SOURCE_MAP_INVALID/);
 assert.throws(()=>portableWorkflowBundle(bundle('var x=1;\r')),/LINE_ENDING_UNSUPPORTED/);
});
