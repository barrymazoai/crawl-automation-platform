// R2 transfer benchmark from this machine: N sequential 1.5MB puts (error rate) then 8 parallel puts and gets (seconds).
//   node r2-bench.mjs <private-config-with-r2> [label]
import fs from 'node:fs/promises';import crypto from 'node:crypto';import {S3Client,PutObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
const c=JSON.parse(await fs.readFile(process.argv[2],'utf8')),label=process.argv[3]??'';
const s3=new S3Client({region:'auto',endpoint:c.r2.endpoint,credentials:{accessKeyId:c.r2Credentials.accessKeyId,secretAccessKey:c.r2Credentials.secretAccessKey},forcePathStyle:true,maxAttempts:1});
const body=crypto.randomBytes(1500000),t=Date.now(),key=i=>`${c.r2.prefix}/diagnostics/r2-bench-${t}-${i}`;
const time=async fn=>{const a=Date.now();try{await fn();return (Date.now()-a)/1000;}catch(e){return 'ERR';}};
const seq=[];for(let i=0;i<6;i++)seq.push(await time(()=>s3.send(new PutObjectCommand({Bucket:c.r2.bucket,Key:key(i),Body:body}))));
const pput=await Promise.all([...Array(8)].map((_,i)=>time(()=>s3.send(new PutObjectCommand({Bucket:c.r2.bucket,Key:key(100+i),Body:body})))));
const pget=await Promise.all([...Array(8)].map((_,i)=>time(async()=>{const r=await s3.send(new GetObjectCommand({Bucket:c.r2.bucket,Key:key(100+i)}));await r.Body.transformToByteArray();})));
const stat=a=>{const n=a.filter(x=>typeof x==='number').sort((x,y)=>x-y);return n.length?`max ${n[n.length-1].toFixed(1)}s err ${a.length-n.length}`:`all ERR`;};
console.log(JSON.stringify({label,seqPut:stat(seq),parPut8:stat(pput),parGet8:stat(pget)}));
