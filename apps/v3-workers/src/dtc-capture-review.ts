import { isDeepStrictEqual as equal } from 'node:util';
import { DtcCaptureStopProofSchema, DtcStoppedCaptureReviewSchema, type DtcProductJob } from '@crawl-automation/v3-contracts';
import { sha256, type RetainedPublication } from '@crawl-automation/v3-artifacts';

/** Executed only on Mini, inside the model permit, before either lease is released. */
export async function verifyDtcCaptureReview(job:DtcProductJob,raw:unknown,execution:{workflowId:string;runId:string},publication:RetainedPublication,s:AbortSignal){
 const receipt=DtcStoppedCaptureReviewSchema.parse(raw),key=`v3/dtc-legacy/${job.operationId}`;
 const invalid=()=>{throw Error('DTC.CAPTURE_STOP_UNVERIFIED');};
 if(receipt.operationId!==job.operationId||receipt.url!==job.discovery.entry.url||receipt.evidenceKey!==`${key}/capture-stop.json`||execution.workflowId!==job.discovery.workflowId)invalid();
 const bytes=await publication.remote.read(receipt.evidenceKey,2*1024*1024,s);
 if(!bytes||sha256(bytes)!==receipt.evidenceSha256)invalid();
 const proof=DtcCaptureStopProofSchema.parse(JSON.parse(Buffer.from(bytes!).toString()));
 if(proof.operationId!==receipt.operationId||proof.url!==receipt.url||!equal(proof.execution,execution)||proof.closure.taskId!==job.sessionId||/user.?control|permission|sandbox|session_unavailable/i.test(proof.result.reasonCode??''))invalid();
 const result=await publication.remote.read(`${key}/result.json`,2*1024*1024,s);
 if(!result||sha256(result)!==proof.resultSha256||!equal(JSON.parse(Buffer.from(result).toString()),proof.result))invalid();
 // Every partial file referred to by the stop proof must already be durable.
 for(const f of proof.files){
  if(f.objectKey!==`${key}/files/${sha256(Buffer.from(f.path))}`||f.byteSize>32*1024*1024)invalid();
  const b=await publication.remote.read(f.objectKey,f.byteSize,s);
  if(!b||b.length!==f.byteSize||sha256(b)!==f.sha256)invalid();
 }
 return receipt;
}
