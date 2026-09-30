import { randomUUID } from 'node:crypto';
import { DtcNodeSessionSchema, type DtcNodeSession } from '@crawl-automation/v3-contracts';
import type { DtcBrowserConfig } from './dtc-live-config.js';
import type { dtcTemporal } from './dtc-temporal-control.js';
import {WorkflowUpdateFailedError,WorkflowUpdateRPCTimeoutOrCancelledError} from '@temporalio/client';
import {WorkflowNotFoundError} from '@temporalio/common';
import {setTimeout as sleep} from 'node:timers/promises';
import {dtcNodeError,type DtcNodeLog} from './dtc-node-log.js';
type Temporal = Awaited<ReturnType<typeof dtcTemporal>>;
const deadline = <T>(t:Temporal,call:()=>Promise<T>) => t.connection.withDeadline(Date.now()+25000,call);
export async function preflightDtcMini(t:Temporal,c:DtcBrowserConfig) {
 const h=await deadline(t,()=>t.client.workflow.start('DtcNodePreflightWorkflow',{
  workflowId:'v3-dtc-doctor-'+randomUUID(),taskQueue:c.nodeControl.workflowQueue,
  args:[{nodeId:c.nodeControl.nodeId,controlQueue:c.nodeControl.activityQueue}],workflowExecutionTimeout:'30 seconds',
 }));
 const r=await deadline(t,()=>h.result()) as any;
 if(r?.status!=='ready'||r.nodeId!==c.nodeControl.nodeId||r.browserResource!==c.browserResource)throw Error('DTC.MINI_UNVERIFIED');
}
export async function openDtcSession(t:Temporal,c:DtcBrowserConfig,session:DtcNodeSession) {
 await deadline(t,()=>t.client.workflow.start('DtcNodeSessionWorkflow',{
  workflowId:`v3-dtc-node-${c.nodeControl.nodeId}`,taskQueue:c.nodeControl.workflowQueue,args:[session],
 }));
}
function rpcCode(error:unknown):number|undefined{
 for(let n=0;n<5&&error&&typeof error==='object';n++){
  const e=error as {code?:unknown;cause?:unknown};if(typeof e.code==='number')return e.code;error=e.cause;
 }return undefined;
}
function uncertain(error:unknown){
 return !(error instanceof WorkflowUpdateFailedError)&&(error instanceof WorkflowUpdateRPCTimeoutOrCancelledError||[1,4,14].includes(rpcCode(error)??-1));
}
export async function reportDtcSession(t:Temporal,session:DtcNodeSession,sequence:number,healthy:boolean,options:{signal?:AbortSignal;log?:DtcNodeLog;rpcTimeoutMs?:number}={}) {
 const {signal}=options,started=performance.now(),timeout=options.rpcTimeoutMs??25000,budget=timeout*3;
 const workflowId=`v3-dtc-node-${session.node.nodeId}`,updateId=`health-${session.sessionId}-${sequence}`;
 const args:[{sessionId:string;sequence:number;healthy:boolean}]=[{sessionId:session.sessionId,sequence,healthy}];
 let targetRunId:string|undefined;
 const log=async(event:string,fields:Record<string,unknown>={})=>options.log?.({event,workflowId,...(targetRunId?{runId:targetRunId}:{}),updateId,sessionId:session.sessionId,sequence,healthy,elapsedMs:Math.round(performance.now()-started),...fields});
 async function call<T>(fn:()=>Promise<T>){
  signal?.throwIfAborted();const remaining=budget-(performance.now()-started);if(remaining<=0)throw Error('DTC.NODE_HEALTH_UNCONFIRMED');
  const run=()=>t.connection.withDeadline(Date.now()+Math.min(timeout,remaining),fn);
  return signal?t.connection.withAbortSignal(signal,run):run();
 }
 async function failed(phase:string,error:unknown){await log('DTC_NODE_HEALTH_CALL_FAILED',{phase,error:dtcNodeError(error)});signal?.throwIfAborted();}
 const validate=(raw:unknown)=>{const r=raw as any;if(r?.status!=='acknowledged'||r.sessionId!==session.sessionId||r.nodeId!==session.node.nodeId)throw Error('DTC.MINI_UNVERIFIED');};
 await log('DTC_NODE_HEALTH_STARTED');
 const current=t.client.workflow.getHandle(workflowId);
 let description:Awaited<ReturnType<typeof current.describe>>|undefined;
 for(let n=0;n<2;n++)try{description=await call(()=>current.describe());break;}catch(error){await failed('describe',error);if(!uncertain(error)||n===1)throw error;}
 if(!description||description.status.name!=='RUNNING')throw Error('DTC.NODE_SESSION_NOT_RUNNING');
 // A lost response must be reconciled against this run, even if the workflow continues as new.
 const h=t.client.workflow.getHandle(workflowId,description.runId),runId=description.runId;targetRunId=runId;
 const submit=()=>call(()=>h.executeUpdate('dtcNodeHealth',{args,updateId}));
 let last:unknown,resent=false;
 try{validate(await submit());await log('DTC_NODE_HEALTH_ACKNOWLEDGED',{runId,reconciled:false});return;}
 catch(error){last=error;await failed('submit',error);if(!uncertain(error))throw error;}
 for(let attempt=1;attempt<=2;attempt++){
  await sleep(Math.min(250,timeout/10),undefined,signal?{signal}:{});
  try{
   validate(await call(()=>h.getUpdateHandle(updateId).result()));
   await log('DTC_NODE_HEALTH_ACKNOWLEDGED',{runId,reconciled:true,attempt});return;
  }catch(error){
   last=error;await failed('reconcile',error);
   if((rpcCode(error)===5||error instanceof WorkflowNotFoundError)&&!resent){
    // gRPC NOT_FOUND: the update was not retained. Resend the identical ID, arguments and run once.
    resent=true;await log('DTC_NODE_HEALTH_RESUBMIT',{runId,attempt});
    try{validate(await submit());await log('DTC_NODE_HEALTH_ACKNOWLEDGED',{runId,reconciled:true,resent:true});return;}
    catch(resendError){last=resendError;await failed('resubmit',resendError);if(!uncertain(resendError))throw resendError;}
   }else if(!uncertain(error))throw error;
  }
 }
 throw Error('DTC.NODE_HEALTH_UNCONFIRMED',{cause:last});
}
export async function closeDtcSession(t:Temporal,raw:unknown) {
 const session=DtcNodeSessionSchema.parse(raw),h=t.client.workflow.getHandle(`v3-dtc-node-${session.node.nodeId}`);
 // Bind result() to this execution chain so a later node start cannot capture it.
 const description=await deadline(t,()=>h.describe());
 const bound=t.client.workflow.getHandle(h.workflowId,description.runId);
 // The workflow validates the session ID, including after Continue-As-New.
 const r=await deadline(t,()=>h.executeUpdate('dtcNodeStop',{args:[session.sessionId],updateId:`stop-${session.sessionId}`})) as any;
 if(r?.status!=='stopped'||r.sessionId!==session.sessionId||r.nodeId!==session.node.nodeId)throw Error('DTC.MINI_UNVERIFIED');
 const result=await deadline(t,()=>bound.result()) as any;
 if(result?.status!=='stopped'||result.sessionId!==session.sessionId)throw Error('DTC.MINI_UNVERIFIED');
}
