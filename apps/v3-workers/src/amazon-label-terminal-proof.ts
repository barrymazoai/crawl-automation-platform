import {isDeepStrictEqual as equal} from 'node:util';
import {sha256,type ObjectStore} from '@crawl-automation/v3-artifacts';
import type {CatalogDiscovery} from '@crawl-automation/v3-contracts';
type Db={query:(sql:string,args:unknown[])=>Promise<{rows:any[]}>};
export const labelRecoveryKey=(runId:string)=>`v3/amazon-label-recovery/${runId}/proof.json`;
/** A recovered failure remains a failure. Only its catalog wait may settle. */
export async function recoveredAmazonLabelFailure(d:CatalogDiscovery,runId:string,db:Db,resourceDb:Db,remote:ObjectStore,signal:AbortSignal){
 const bytes=await remote.read(labelRecoveryKey(runId),131072,signal);if(!bytes)return false;
 const p=JSON.parse(Buffer.from(bytes).toString());
 if(p.codec!=='amazon-label-stop-recovery/1'||p.requestId!==d.catalogId||p.workflowId!==d.workflowId||p.runId!==runId||p.status!=='FAILED'||!equal(p.discovery,d)||
  p.child?.workflowId!==d.workflowId+'-label'||!['COMPLETED','FAILED','TERMINATED','CANCELLED','TIMED_OUT'].includes(p.child?.status)||
  !p.taskId?.startsWith('amazon-page-')||typeof p.targetId!=='string'||!/^[a-f0-9]{64}$/.test(p.closedSha256??'')||
  p.closed?.sha256!==p.closedSha256||!Array.isArray(p.targetsAbsent)||p.targetsAbsent.length!==3||!p.targetsAbsent.every((x:unknown)=>x===true)||!Array.isArray(p.stops)||!p.stops.length)return false;
 for(const item of [p.history,p.child.history,p.closed]){
  if(typeof item?.key!=='string'||!item.key.startsWith(`v3/amazon-label-recovery/${runId}/`)||!/^[a-f0-9]{64}$/.test(item.sha256??''))return false;
  const raw=await remote.read(item.key,16*1024*1024,signal);if(!raw||sha256(raw)!==item.sha256)return false;
 }
 for(const stop of p.stops){
  const row=(await resourceDb.query('select request,released_at from resource_permit where permit_id=$1',[stop.request?.permitId])).rows[0];
  if(!row?.released_at||!equal(row.request,stop.request)||stop.request.workflowId!==p.child.workflowId||stop.request.runId!==p.child.runId)return false;
  if(stop.evidenceKey!==`v3/resource-stop/${stop.request.permitId}.json`)return false;
  const raw=await remote.read(stop.evidenceKey,65536,signal);if(!raw||sha256(raw)!==stop.sha256)return false;
  const proof=JSON.parse(Buffer.from(raw).toString()),review=(await db.query('select record from review_record where review_id=$1',[proof.reviewId])).rows[0]?.record;
  if(proof.codec!=='owned-model-review-stop/1'||!equal(proof.request,stop.request)||review?.observation?.requestId!==d.catalogId||review.observation.listingId!==d.entry.listingId||review.failure.executionFact!=='executed')return false;
 }
 return true;
}
