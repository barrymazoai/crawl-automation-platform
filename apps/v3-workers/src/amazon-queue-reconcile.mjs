// Operator command behind CLEANUP_FAILED_MANUAL_REQUIRED. Manual, one shot.
//
//   node amazon-queue-reconcile.mjs <health.private.json> [--audit]
//
// It re-runs the exact-executor cleanup once for permits whose automatic attempt
// already failed, under a new attempt id and a fresh cleanup directory, and
// records the outcome on the same claims so the health guard unlatches only when
// the permits are actually released. --audit reads everything and mutates
// nothing. No business task is retried; Review and failure records stay as they are.
import fs from 'node:fs';
import pg from 'pg';
import {Client,Connection} from '@temporalio/client';
import {inspectClosedBatchPermits,recoverClosedBatchPermits} from './amazon-queue-recovery.mjs';
import {reconcileOnce,claimPath} from './recovery-attempt.mjs';
import {runWindowsPowerShell} from './windows-powershell.mjs';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const [configPath,...flags]=process.argv.slice(2);
if(!configPath)throw Error('Usage: amazon-queue-reconcile <health.private.json> [--audit]');
const audit=flags.includes('--audit');
const config=read(configPath),{root,out,connectionFile,windowsSsh}=config;
const ps=source=>runWindowsPowerShell(windowsSsh,source);
const say=value=>console.log(JSON.stringify({at:new Date().toISOString(),...value}));
const initial=read(root+'/live/deployment.json');
const db=new pg.Pool({connectionString:initial.database.connectionString,max:3,statement_timeout:30000,connectionTimeoutMillis:5000});
let connection;
try{
 const c=read(connectionFile),t=c.transport;
 connection=await Connection.connect({address:c.address,connectTimeout:'15 seconds',tls:{serverNameOverride:t.serverName,serverRootCACertificate:fs.readFileSync(t.caFile),clientCertPair:{crt:fs.readFileSync(t.certFile),key:fs.readFileSync(t.keyFile)}}});
 const client=new Client({connection,namespace:config.namespace}),m=read(root+'/live/deployment.json');
 const state={entries:(await db.query("SELECT request_id AS \"requestId\",'ACTIVE' AS state FROM amazon_queue_item WHERE state='running'")).rows};
 const recovery=await connection.withDeadline(Date.now()+30000,()=>inspectClosedBatchPermits({db,client,state}));
 const permits=recovery.permits.map(p=>({permitId:p.request.permitId,status:p.status,needs:p.request.needs}));
 const claims=recovery.permits.map(p=>{const path=claimPath(out,p.request.permitId);return fs.existsSync(path)?JSON.parse(fs.readFileSync(path)):null;});
 say({event:'RECONCILE_INSPECTED',audit,pause:recovery.pause,recover:recovery.recover,reason:recovery.reason,permits,claims:claims.map(c=>c&&{id:c.id,status:c.status,error:c.error})});
 if(!recovery.permits.length){say({event:'RECONCILE_NOTHING_HELD'});process.exitCode=0;}
 else if(!recovery.recover){say({event:'RECONCILE_NOT_READY',reason:recovery.reason??'OWNERS_OR_PRODUCTS_STILL_RUNNING'});process.exitCode=2;}
 else if(audit){
  const proof=await recoverClosedBatchPermits({snapshot:recovery,db,client,root,out,m,ps,auditOnly:true});
  say({event:'RECONCILE_AUDIT',proof});
 }else{
  const outcome=await reconcileOnce({out,permits:recovery.permits,run:id=>{say({event:'RECONCILE_STARTED',attemptId:id,permits:recovery.permits.length});return recoverClosedBatchPermits({snapshot:recovery,db,client,root,out,m,ps,id});}});
  say({event:'RECONCILE_'+outcome.status.toUpperCase(),...outcome});
  process.exitCode=outcome.status==='reconciled'?0:1;
 }
}finally{await connection?.close();await db.end();}
