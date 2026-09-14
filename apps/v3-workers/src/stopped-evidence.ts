import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {sha256,type RetainedPublication} from '@crawl-automation/v3-artifacts';

const conflict=()=>{throw Error('RESOURCE.STOP_EVIDENCE_CONFLICT');};
/** Only immutable attestations of already stopped model work may resume an existing claim.
 * This has no provider, permit-release, overwrite or delete capability. */
export async function publishStoppedEvidence(publication:RetainedPublication,key:string,bytes:Buffer,signal:AbortSignal){
 const evidence=JSON.parse(bytes.toString()),inv=evidence.invocation;
 if(!inv||!/^[a-f0-9]{64}$/.test(inv.returned??'')||typeof inv.operationId!=='string'||typeof evidence.reviewId!=='string')conflict();
 const expected=evidence.codec==='model-return-attestation/1'
  ?`v3/model-returns/${sha256(Buffer.from(JSON.stringify([inv.workflowId,inv.runId,inv.activityName,inv.operationId])))}.json`
  :evidence.codec==='owned-model-review-stop/1'&&evidence.request?.workflowId===inv.workflowId&&evidence.request?.runId===inv.runId
   ?`v3/resource-stop/${evidence.request.permitId}.json`:null;
 if(key!==expected)conflict();
 const lifetime=AbortSignal.any([signal,AbortSignal.timeout(65000)]),digest=sha256(bytes),claimKey=`v3/publication-claims/${sha256(Buffer.from(key))}.json`;
 const check=(saved:Uint8Array|null)=>{if(saved&&sha256(saved)!==digest)conflict();return !!saved;};
 const claim=(saved:Uint8Array)=>{const c=JSON.parse(Buffer.from(saved).toString());
  if(Object.keys(c).sort().join(',')!=='key,nonce,sha256'||c.key!==key||c.sha256!==digest||typeof c.nonce!=='string'||!/^[a-f0-9-]{36}$/.test(c.nonce))conflict();return c;};
 await publication.retain(key,bytes,'application/json',lifetime);
 let stage='read-proof';
 for(let attempt=1;attempt<=3;attempt++){
  const started=Date.now();
  const io=()=>AbortSignal.any([lifetime,AbortSignal.timeout(8000)]);
  try{
   stage='read-proof';if(check(await publication.remote.read(key,bytes.length,io())))return;
   stage='read-claim';const remoteClaim=await publication.remote.read(claimKey,4096,io()),localClaim=await publication.local.read(claimKey,4096,lifetime);
   const chosen=remoteClaim??localClaim??Buffer.from(JSON.stringify({key,sha256:digest,nonce:randomUUID()}));claim(chosen);
   if(remoteClaim&&localClaim&&!isDeepStrictEqual(claim(remoteClaim),claim(localClaim)))conflict();
   stage='retain-claim';await publication.local.create(claimKey,chosen,'application/json',lifetime);
   const retained=await publication.local.read(claimKey,4096,lifetime);if(!retained)throw Error('RESOURCE.STOP_EVIDENCE_CONFLICT');if(!isDeepStrictEqual(claim(retained),claim(chosen)))conflict();
   if(!remoteClaim){stage='create-claim';await publication.remote.create(claimKey,retained,'application/json',io());}
   stage='verify-claim';const shared=await publication.remote.read(claimKey,4096,io());if(!shared)throw Error('RESOURCE.STOP_PUBLICATION_UNAVAILABLE');
   if(!isDeepStrictEqual(claim(shared),claim(retained)))conflict();
   stage='create-proof';await publication.remote.create(key,bytes,'application/json',io());
   stage='verify-proof';if(check(await publication.remote.read(key,bytes.length,io())))return;
   throw Error('RESOURCE.STOP_PUBLICATION_UNAVAILABLE');
  }catch(error){
   const e=error as {name?:string;code?:string;message?:string;diagnostics?:unknown};
   console.error(JSON.stringify({event:'STOP_EVIDENCE_IO_FAILED',key,stage,attempt,elapsedMs:Date.now()-started,
    code:/^(ARTIFACT|RESOURCE)\.[A-Z_]+$/.test(e.code??e.message??'')?(e.code??e.message):'RESOURCE.STOP_IO_UNKNOWN',
    name:/^[A-Za-z]{1,50}$/.test(e.name??'')?e.name:'Error',...(e.diagnostics?{io:e.diagnostics}:{})}));
   if(e.message==='RESOURCE.STOP_EVIDENCE_CONFLICT')throw error;
   lifetime.throwIfAborted();if(attempt===3)throw Error('RESOURCE.STOP_PUBLICATION_UNAVAILABLE');
   await delay(200,undefined,{signal:lifetime});
  }
 }
}
