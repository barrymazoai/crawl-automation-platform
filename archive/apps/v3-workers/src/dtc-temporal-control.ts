import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { DtcBrowserControlSchema, type DtcBrowserControl } from '@crawl-automation/v3-contracts';
import type { WorkerConfig } from '@crawl-automation/v3-worker-runtime';

export async function dtcTemporal(config:WorkerConfig){
 const t=config.transport;
 const connection=await Connection.connect({address:config.address,connectTimeout:'15 seconds',...(t.mode==='mtls'?{tls:{serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}}}:{})});
 return{connection,client:new Client({connection,namespace:config.namespace})};
}
/** The current parent Workflow routes these requests to its Mini Activity queue.
 * The Windows process has no database address, client, or query interface. */
export async function requestDtcControl(temporal:Awaited<ReturnType<typeof dtcTemporal>>,execution:{workflowId:string;runId:string},raw:DtcBrowserControl,signal:AbortSignal){
 const input=DtcBrowserControlSchema.parse(raw);signal.throwIfAborted();
 const result=await temporal.connection.withAbortSignal(signal,()=>temporal.connection.withDeadline(Date.now()+25000,()=>
   temporal.client.workflow.getHandle(execution.workflowId,execution.runId).executeUpdate('dtcBrowserControl',{args:[input],updateId:randomUUID()})));
 signal.throwIfAborted();return result;
}
