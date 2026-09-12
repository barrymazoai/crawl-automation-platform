import {it,expect} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {WorkflowUpdateFailedError,WorkflowUpdateRPCTimeoutOrCancelledError} from '@temporalio/client';
import {reportDtcSession} from '../src/dtc-node-session.js';
import {dtcNodeError,dtcNodeLogger} from '../src/dtc-node-log.js';
import {DtcNodeSessionSchema} from '@crawl-automation/v3-contracts';

const session=DtcNodeSessionSchema.parse({node:{nodeId:'dtc-fixture',host:'fixture',root:'D:\\fixture'},sessionId:'00000000-0000-4000-8000-000000000001',controlQueue:'fixture'});
const rpc=(code:number)=>Object.assign(Error('fixture transport failure'),{code});
const timeout=()=>new WorkflowUpdateRPCTimeoutOrCancelledError('fixture waiting failed',{cause:rpc(4)});
function fixture(submit:()=>Promise<unknown>,read:()=>Promise<unknown>){
 const calls:any[]=[],events:any[]=[],ack={status:'acknowledged',nodeId:session.node.nodeId,sessionId:session.sessionId};
 const temporal={connection:{withDeadline:async(deadline:number,fn:()=>Promise<unknown>)=>{expect(deadline-Date.now()).toBeLessThanOrEqual(1000);return fn();},withAbortSignal:async(_s:AbortSignal,fn:()=>Promise<unknown>)=>fn()},client:{workflow:{getHandle:(id:string,runId?:string)=>{
  calls.push({action:'handle',id,runId});return {describe:async()=>({runId:'original-run',status:{name:'RUNNING'}}),
   executeUpdate:async(name:string,options:any)=>{calls.push({action:'submit',runId,name,options});return submit();},
   getUpdateHandle:(updateId:string)=>({result:async()=>{calls.push({action:'read',runId,updateId});return read();}})};
 }}}};
 return {temporal:temporal as unknown as Parameters<typeof reportDtcSession>[0],calls,events,ack,options:{rpcTimeoutMs:1000,log:async(e:any)=>{events.push(e);}}};
}
it('reconciles a lost reply against the original run and exact update ID without another submission',async()=>{
 let f:ReturnType<typeof fixture>;f=fixture(async()=>{throw timeout();},async()=>f.ack);
 await reportDtcSession(f.temporal,session,570,true,f.options);
 expect(f.calls.filter(c=>c.action==='submit')).toHaveLength(1);
 expect(f.calls.filter(c=>c.action==='read')).toEqual([{action:'read',runId:'original-run',updateId:'health-'+session.sessionId+'-570'}]);
 expect(f.events.at(-1)).toMatchObject({event:'DTC_NODE_HEALTH_ACKNOWLEDGED',sequence:570,healthy:true,reconciled:true});
 expect(f.events.find(e=>e.event==='DTC_NODE_HEALTH_CALL_FAILED').error.cause.code).toBe(4);
 expect(f.events.find(e=>e.event==='DTC_NODE_HEALTH_CALL_FAILED')).toMatchObject({runId:'original-run',updateId:'health-'+session.sessionId+'-570'});
});
it('resubmits only the identical update after a missing result, never a new sequence or run',async()=>{
 let count=0,f:ReturnType<typeof fixture>;f=fixture(async()=>{if(++count===1)throw timeout();return f.ack;},async()=>{throw rpc(5);});
 await reportDtcSession(f.temporal,session,570,true,f.options);
 const calls=f.calls.filter(c=>c.action==='submit');expect(calls).toHaveLength(2);expect(calls[0]).toEqual(calls[1]);
 expect(f.calls.findIndex(c=>c.action==='read')).toBeLessThan(f.calls.lastIndexOf(calls[1]));
});
it.each(['permission','application','invalid-receipt','cancelled'])('does not reconcile a definitive %s result',async mode=>{
 const abort=new AbortController();const failure=mode==='permission'?rpc(7):new WorkflowUpdateFailedError('session rejected',Error('DTC.NODE_SESSION_CONFLICT'));
 const f=fixture(async()=>{if(mode==='invalid-receipt')return {status:'acknowledged',sessionId:'foreign'};if(mode==='cancelled'){abort.abort(Error('requested stop'));throw timeout();}throw failure;},async()=>{throw Error('unexpected read');});
 await expect(reportDtcSession(f.temporal,session,1,true,{...f.options,signal:abort.signal})).rejects.toThrow();
 expect(f.calls.filter(c=>c.action==='read')).toHaveLength(0);
});
it('bounds an unavailable reconciliation and preserves the actual transport cause',async()=>{
 const f=fixture(async()=>{throw timeout();},async()=>{throw rpc(14);});
 let error:unknown;try{await reportDtcSession(f.temporal,session,1,true,f.options);}catch(e){error=e;}
 expect(error).toMatchObject({message:'DTC.NODE_HEALTH_UNCONFIRMED',cause:{code:14}});
 expect(f.calls.filter(c=>c.action==='submit')).toHaveLength(1);expect(f.calls.filter(c=>c.action==='read')).toHaveLength(2);
});
it('writes ordered node events with error codes and causes while omitting sensitive SDK metadata',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dtc-node-log-'));
 try{
  const error=Object.assign(Error('request https://user:example-password@example.test/path?access_token=example-token'),{code:4,details:'Bearer example-token',cause:rpc(14),metadata:{authorization:'example-token'}});
  const value=dtcNodeError(error),log=dtcNodeLogger(root);
  await Promise.all([log({event:'failed',sequence:570,error:value}),log({event:'exit',exitCode:1})]);
  const text=await readFile(join(root,'node-events.jsonl'),'utf8'),rows=text.trim().split('\n').map(s=>JSON.parse(s));
  expect(rows.map(r=>r.event)).toEqual(['failed','exit']);expect(rows[0].error).toMatchObject({code:4,cause:{code:14}});
  expect(text).not.toContain('example-password');expect(text).not.toContain('example-token');expect(text).not.toContain('metadata');expect(rows.every(r=>r.at&&r.pid)).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('the built supervisor CLI retains an actual command error and its numeric process exit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dtc-node-cli-'));
 try{
  const entry=fileURLToPath(new URL('../dtc-windows/dtc-node.js',import.meta.url));
  const child=spawnSync(process.execPath,[entry,'doctor',join(root,'missing-node.json')],{encoding:'utf8',timeout:10000});
  expect(child.status).toBe(1);const events=child.stderr.trim().split('\n').map(line=>JSON.parse(line));
  expect(events.find(e=>e.event==='DTC_NODE_COMMAND_FAILED')).toMatchObject({command:'doctor',error:{code:'ENOENT'}});
  expect(events.at(-1)).toMatchObject({event:'DTC_NODE_PROCESS_EXIT',exitCode:1});
 }finally{await rm(root,{recursive:true,force:true});}
});
