import {isDeepStrictEqual as equal} from 'node:util';
import {sha256,type ObjectStore} from '@crawl-automation/v3-artifacts';
import type {CatalogDiscovery} from '@crawl-automation/v3-contracts';

/** A failed attempt is settled only after the separate recovery verifier has
 * retained its terminal history and exact page-cleanup proof and released it.
 * This does not turn a failed product into a collected product. */
type ReadDatabase={query:(sql:string,args:unknown[])=>Promise<{rows:any[]}>};
export async function recoveredAmazonFailure(d:CatalogDiscovery,runId:string,db:ReadDatabase,resourceDb:ReadDatabase,remote:ObjectStore,signal:AbortSignal){
 const rows=(await resourceDb.query("select permit_id,request,released_at from resource_permit where request->>'workflowId'=$1 and request->>'runId'=$2",[d.workflowId,runId])).rows;
 if(rows.length!==1||!rows[0].released_at)return false;
 const row=rows[0],key=`v3/amazon-history-recovery/${row.permit_id}/proof.json`,raw=await remote.read(key,65536,signal);
 if(!raw)return false;const p=JSON.parse(Buffer.from(raw).toString());
 if(p.codec!=='amazon-browser-recovery/2'||p.workflowStatus!=='FAILED'||p.requestId!==d.catalogId||!equal(p.request,row.request)||
  p.request.workflowId!==d.workflowId||p.request.runId!==runId||!equal(p.request.needs,[{resourceId:'mini-ego-space-1',units:1}])||
  !Array.isArray(p.targetsAbsent)||p.targetsAbsent.length!==3||!p.targetsAbsent.every((v:unknown)=>v===true)||
  typeof p.targetId!=='string'||!p.targetId||!p.taskId?.startsWith('amazon-page-')||!/^[a-f0-9]{64}$/.test(p.closedSha256)||!Array.isArray(p.children))return false;
 const history=await remote.read(key.replace('proof.json','history.json'),16*1024*1024,signal);
 if(!history||sha256(history)!==p.historySha256)return false;
 for(let n=0;n<p.children.length;n++){
  const c=p.children[n];if(c.workflowId!==d.workflowId+'-label'||!['COMPLETED','FAILED'].includes(c.status)||c.heldPermits!==0)return false;
  const bytes=await remote.read(key.replace('proof.json',`child-${n}.json`),16*1024*1024,signal);
  if(!bytes||sha256(bytes)!==c.historySha256)return false;
 }
 const review=(await db.query('select record from review_record where review_id=$1',[p.reviewId])).rows[0]?.record;
 return !!review&&review.observation.requestId===d.catalogId&&review.observation.listingId===d.entry.listingId&&review.observation.sourceId===d.scope.sourceId&&review.observation.brandId===d.scope.brandId;
}
