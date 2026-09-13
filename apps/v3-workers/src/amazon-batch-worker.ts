import {readFile,readdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {Context} from '@temporalio/activity';
import {Client,Connection} from '@temporalio/client';
import {ApplicationFailure} from '@temporalio/common';
import {RoleRegistry,artifactBuildId,workerProcess,taskQueueFor} from '@crawl-automation/v3-worker-runtime';
import {readGncPrivateJson} from './gnc-config.js';
import {AmazonBatchConfigSchema,AmazonBatchController} from './amazon-batch-control.js';
import type {BatchCall} from './amazon-batch-contract.js';

async function main(){
 if(process.env.V3_AMAZON_BATCH_ENABLED!=='true'||!process.env.V3_AMAZON_BATCH_CONFIG)throw Error('Explicit batch config required');
 const config=AmazonBatchConfigSchema.parse(await readGncPrivateJson(process.env.V3_AMAZON_BATCH_CONFIG));
 const output=dirname(fileURLToPath(import.meta.url));
 const buildId=await artifactBuildId((await readdir(output)).filter(n=>n.endsWith('.js')||n==='amazon-batch-workflows.cjs').sort().map(n=>join(output,n)));
 const base={compatibility:'amazon-batch-v1',contractVersion:1,buildId,testOnly:false,sessionScoped:true as const};
 await workerProcess(new RoleRegistry('business',[
  {...base,role:'amazon-batch-workflow',capability:'amazon.batch.workflow',kind:'workflow',prepare:async()=>({kind:'workflow',workflowBundle:{codePath:join(output,'amazon-batch-workflows.cjs')},dispose:async()=>{}})},
  {...base,role:'amazon-batch-control',capability:'amazon.batch.control',kind:'activity',async prepare(runtime){
   if(taskQueueFor(runtime)!==config.controlQueue)throw Error('AMAZON.BATCH_QUEUE');
   const admin=await readGncPrivateJson(config.adminFile) as {database:{connectionString:string;tls:boolean}};
   const db=new pg.Pool({connectionString:admin.database.connectionString,ssl:admin.database.tls?{rejectUnauthorized:true}:false,max:2,connectionTimeoutMillis:5000,statement_timeout:5000});
   let connection:Connection|undefined;
   const dispose=async()=>{await connection?.close();await db.end();};
   try{
    const t=runtime.transport;
    connection=await Connection.connect({address:runtime.address,connectTimeout:'15 seconds',...(t.mode==='mtls'?{tls:{serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}}}:{})});
    const controller=await AmazonBatchController.open(config,db,new Client({connection,namespace:runtime.namespace}));
    const names=['loadAmazonHistoryBatch','submitAmazonHistoryChunk','inspectAmazonHistoryChunk','recoverAmazonHistoryChunk','reportAmazonHistoryBatch'] as const;
    return{kind:'activity',dispose,activities:Object.fromEntries(names.map(name=>[name,async(raw:unknown)=>{
     const context=Context.current();
     if(context.info.workflowExecution?.workflowId!==config.campaignId||context.info.workflowType!=='AmazonHistoryBatchWorkflow')throw ApplicationFailure.nonRetryable('Campaign mismatch','AMAZON.BATCH_OWNER');
     const timer=setInterval(()=>context.heartbeat({activity:name}),2000);
     try{return await controller[name](raw as BatchCall,context.cancellationSignal);}
     finally{clearInterval(timer);}
    }]))};
   }catch(error){await dispose();throw error;}
  }},
 ]));
}
main().catch(()=>{console.error(JSON.stringify({event:'AMAZON_BATCH_STARTUP_REJECTED'}));process.exitCode=1;});
