import {it,expect} from 'vitest';
import {sha256,type ObjectStore} from '@crawl-automation/v3-artifacts';
import {recoveredAmazonFailure} from './amazon-terminal-proof.js';
import type {CatalogDiscovery} from '@crawl-automation/v3-contracts';
function fixture(){
 const d={workflowId:'product',catalogId:'batch',entry:{listingId:'B000REPUY0'},scope:{sourceId:'source',brandId:'brand'}} as CatalogDiscovery;
 const request={permitId:'permit',workflowId:'product',runId:'run',needs:[{resourceId:'mini-ego-space-1',units:1}]};
 const history=Buffer.from('retained history'),row={permit_id:'permit',request,released_at:'2026-09-13T00:00:00Z'};
 const proof={codec:'amazon-browser-recovery/2',workflowStatus:'FAILED',request,requestId:'batch',targetsAbsent:[true,true,true],targetId:'target',taskId:'amazon-page-task',closedSha256:'a'.repeat(64),historySha256:sha256(history),children:[],reviewId:'review'};
 const review={observation:{requestId:'batch',listingId:'B000REPUY0',sourceId:'source',brandId:'brand'}};
 const remote: ObjectStore={read:async k=>k.endsWith('/proof.json')?Buffer.from(JSON.stringify(proof)):history,create:async()=>{throw Error('read only');}};
 const db={query:async(sql:string)=>({rows:sql.includes('resource_permit')?[row]:[{record:review}]})};
 return {proof,row,review,run:()=>recoveredAmazonFailure(d,'run',db,db,remote,AbortSignal.timeout(1000))};
}
it('allows settlement of a proved and released failure without calling it collected',async()=>{expect(await fixture().run()).toBe(true);});
it.each(['held','wrong-run','wrong-product','page-present','altered-history','unknown-child'] as const)('rejects %s recovery evidence',async mode=>{
 const f=fixture();if(mode==='held')f.row.released_at='';if(mode==='wrong-run')f.proof.request={...f.proof.request,runId:'other'};
 if(mode==='wrong-product')f.review.observation.listingId='B000000001';if(mode==='page-present')f.proof.targetsAbsent[1]=false;
 if(mode==='altered-history')f.proof.historySha256='0'.repeat(64);if(mode==='unknown-child')(f.proof.children as unknown[]).push({workflowId:'foreign',status:'COMPLETED',heldPermits:0});
 expect(await f.run()).toBe(false);
});
