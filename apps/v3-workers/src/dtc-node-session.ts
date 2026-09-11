import { randomUUID } from 'node:crypto';
import { DtcNodeSessionSchema, type DtcNodeSession } from '@crawl-automation/v3-contracts';
import type { DtcBrowserConfig } from './dtc-live-config.js';
import type { dtcTemporal } from './dtc-temporal-control.js';
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
export async function reportDtcSession(t:Temporal,session:DtcNodeSession,sequence:number,healthy:boolean) {
 const r=await deadline(t,()=>t.client.workflow.getHandle(`v3-dtc-node-${session.node.nodeId}`).executeUpdate('dtcNodeHealth',{
  args:[{sessionId:session.sessionId,sequence,healthy}],updateId:`health-${session.sessionId}-${sequence}`,
 })) as any;
 if(r?.status!=='acknowledged'||r.sessionId!==session.sessionId||r.nodeId!==session.node.nodeId)throw Error('DTC.MINI_UNVERIFIED');
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
