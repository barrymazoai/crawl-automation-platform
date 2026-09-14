import {expect,it} from 'vitest';
import {sha256} from '@crawl-automation/v3-artifacts';
import {labelRecoveryKey,recoveredAmazonLabelFailure} from './amazon-label-terminal-proof.js';
function fixture(){
 const d:any={catalogId:'request',workflowId:'product',entry:{listingId:'ASIN'}},run='parent-run',prefix=`v3/amazon-label-recovery/${run}/`,objects=new Map<string,Buffer>();
 const save=(key:string,value:unknown)=>{const b=Buffer.from(JSON.stringify(value));objects.set(key,b);return{key,sha256:sha256(b)};};
 const request={permitId:'permit',workflowId:'product-label',runId:'child-run',needs:[{resourceId:'model',units:1}]};
 const stop=save('v3/resource-stop/permit.json',{codec:'owned-model-review-stop/1',request,reviewId:'review'}),closed=save(prefix+'closed.json',{taskId:'amazon-page-1',targetId:'target'});
 const proof:any={codec:'amazon-label-stop-recovery/1',requestId:'request',discovery:d,workflowId:'product',runId:run,status:'FAILED',history:save(prefix+'parent.json.gz','parent'),
 child:{workflowId:'product-label',runId:'child-run',status:'TERMINATED',history:save(prefix+'child.json.gz','child')},taskId:'amazon-page-1',targetId:'target',targetsAbsent:[true,true,true],closedSha256:closed.sha256,closed,
 stops:[{request,evidenceKey:stop.key,sha256:stop.sha256}]};
 const row:any={request,released_at:'2026-09-14'},review:any={observation:{requestId:'request',listingId:'ASIN'},failure:{executionFact:'executed'}};
 const check=()=>{save(labelRecoveryKey(run),proof);return recoveredAmazonLabelFailure(d,run,{query:async()=>({rows:[{record:review}]})},{query:async()=>({rows:[row]})},{read:async(key:string)=>objects.get(key)} as any,new AbortController().signal);};
 return{proof,objects,row,review,check};
}
it('settles a recovered failed product only after exact proof and permit readback',async()=>{expect(await fixture().check()).toBe(true);});
it.each(['held','foreign-permit','missing-history','changed-stop','page-present','foreign-review','unknown-execution','wrong-child'])('does not settle with %s',async mode=>{
 const f=fixture();if(mode==='held')f.row.released_at=null;if(mode==='foreign-permit')f.row.request={...f.row.request,runId:'other'};
 if(mode==='missing-history')f.objects.delete(f.proof.child.history.key);if(mode==='changed-stop')f.objects.set(f.proof.stops[0].evidenceKey,Buffer.from('{}'));
 if(mode==='page-present')f.proof.targetsAbsent[1]=false;if(mode==='foreign-review')f.review.observation.requestId='other';
 if(mode==='unknown-execution')f.review.failure.executionFact='unknown';if(mode==='wrong-child')f.proof.child.workflowId='other';
 expect(await f.check()).toBe(false);
});
