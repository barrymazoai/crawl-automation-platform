// Loopback-only acceptance composition of the existing web/API/delivery modules.
import { createServer } from "node:http";
import { readFile,stat } from "node:fs/promises";
import { resolve,extname } from "node:path";
import { z } from "zod";
import pg from "pg";
import { Connection,Client } from "@temporalio/client";
import { createApp } from "../../v3-api/src/http/app.js";
import { PostgresBrands } from "../../v3-api/src/storage/postgres-brands.js";
import { PostgresDashboard } from "../../v3-api/src/storage/postgres-dashboard.js";
import { PostgresSubmissions } from "../../v3-api/src/storage/postgres-submissions.js";
import { PostgresDelivery } from "../../v3-api/src/storage/postgres-delivery.js";
import { PostgresDeliveryScan } from "../../v3-api/src/storage/postgres-delivery-scan.js";
import { DeliveryCoordinator } from "../../v3-api/src/delivery/coordinator.js";
import { TemporalGateway } from "../../v3-api/src/delivery/temporal-gateway.js";
import { RoutedDeliveryCoordinator } from "../../v3-api/src/delivery/routed-coordinator.js";
import { DeliveryRunner } from "../../v3-api/src/delivery/runner.js";
import { parseDeliverySettings } from "../../v3-api/src/bootstrap/delivery-config.js";
import { PostgresReviews,ReviewInspector } from "@crawl-automation/v3-review";
import { WorkerHealthFile } from "../../../packages/v3-worker-runtime/src/health.js";
import { readGncPrivateJson } from "./gnc-config.js";
import { migrationNames,digest,schemaStatus } from "../../v3-api/src/bootstrap/schema.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TemporalSchedules } from "../../v3-api/src/schedules/service.js";
import { scheduleSourceReader } from "../../v3-api/src/schedules/source-reader.js";
const schema=z.strictObject({databaseUrl:z.string(),token:z.string().min(32),port:z.union([z.literal(4188),z.literal(4189)]),webRoot:z.string(),delivery:z.unknown(),ui:z.array(z.strictObject({clusterId:z.string(),baseUrl:z.url()}))});
async function main(){
  if(process.env.V3_BRAND_WEB_ENABLED!=="true"||!process.env.V3_BRAND_WEB_CONFIG)throw Error("Web opt-in required");
  const c=schema.parse(await readGncPrivateJson(process.env.V3_BRAND_WEB_CONFIG)),delivery=parseDeliverySettings(c.databaseUrl,c.delivery),origin=`http://127.0.0.1:${c.port}`;
  if(delivery.target.workflowType!=="BrandCollectionWorkflow")throw Error("Wrong acceptance target");
  const db=new pg.Pool({connectionString:c.databaseUrl,max:8,connectionTimeoutMillis:5000,statement_timeout:5000});
  const t=delivery.transport,connection=await Connection.connect({address:delivery.address,connectTimeout:"20 seconds",...(t.mode==="mtls"?{tls:{serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}}}:{})});
  const signal=new AbortController();process.once("SIGINT",()=>signal.abort());process.once("SIGTERM",()=>signal.abort());
  const health=process.env.V3_WORKER_HEALTH_FILE?new WorkerHealthFile(process.env.V3_WORKER_HEALTH_FILE):undefined;
  const root=dirname(fileURLToPath(import.meta.url)),migrations=await Promise.all(migrationNames.map(async name=>{const sql=await readFile(resolve(root,"migrations",name),"utf8");return{name,sql,sha256:digest(sql)};}));
  if((await schemaStatus(db,migrations)).pending.length)throw Error("Explicit migration required");
  const submissions=new PostgresSubmissions(db),journal=new PostgresDelivery(db),reviews=new PostgresReviews(db);
  const client=new Client({connection,namespace:delivery.target.namespace});
  const schedules=new TemporalSchedules(client,{clusterId:delivery.target.clusterId,namespace:delivery.target.namespace,taskQueue:"v3.schedule.intake.workflow.v1.schedule-v1"},scheduleSourceReader(db));
  const app=createApp(new PostgresBrands(db),c.token,{submissions,delivery:journal,acceptSubmissions:true,schedules,dashboard:new PostgresDashboard(db,c.ui),reviews,reviewInspector:new ReviewInspector(reviews),collectionUi:{environment:"isolated-live",temporalUi:c.ui}});
  const coordinator=delivery.channelTargets
    ?new RoutedDeliveryCoordinator(submissions,journal,delivery.channelTargets,target=>new TemporalGateway(client,target),delivery.target)
    :new DeliveryCoordinator(submissions,journal,new TemporalGateway(client,delivery.target));
  const runner=new DeliveryRunner(new PostgresDeliveryScan(db),coordinator,delivery,async()=>{try{await stat(delivery.pauseFile);return true;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e;}},event=>console.log(JSON.stringify(event)));
  const server=createServer(async(req,res)=>{
    try{
      res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");
      const deny=(status=403)=>{res.writeHead(status);res.end();};
      if(req.headers.host!==`127.0.0.1:${c.port}`||(req.headers.origin&&req.headers.origin!==origin))return deny();
      const url=new URL(req.url!,origin);
      if(url.pathname.startsWith("/api/v3/")){
        if(req.headers["x-v3-client"]!=="local-workspace"||(req.headers["sec-fetch-site"]&&req.headers["sec-fetch-site"]!=="same-origin")||(req.method!=="GET"&&req.headers.origin!==origin))return deny();
        const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16384)return deny(413);chunks.push(chunk);}
        const headers=new Headers({authorization:`Bearer ${c.token}`});
        for(const name of ["content-type","idempotency-key"])if(typeof req.headers[name]==="string")headers.set(name,req.headers[name]);
        const response=await app.request(url.pathname+url.search,{method:req.method??"GET",headers,...(size?{body:Buffer.concat(chunks)}:{})});
        res.writeHead(response.status,{"Content-Type":"application/json"});res.end(await response.text());return;
      }
      if(req.method!=="GET")return deny();
      if(url.pathname==="/"||url.pathname==="/v3-live.html"){
        const html=(await readFile(resolve(c.webRoot,"v3-live.html"),"utf8")).replace("</head>",'<meta name="v3-dataset" content="A批隔离真实Brand采集；非生产数据库"></head>');
        res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});res.end(html);return;
      }
      if(!/^\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2?)$/.test(url.pathname))return deny(404);
      const type=extname(url.pathname)===".js"?"text/javascript":extname(url.pathname)===".css"?"text/css":"font/woff2";
      res.writeHead(200,{"Content-Type":type});res.end(await readFile(resolve(c.webRoot,`.${url.pathname}`)));
    }catch{res.writeHead(503);res.end('{"error":{"code":"UNAVAILABLE","message":"Isolated service unavailable"}}');}
  });
  await new Promise<void>((ok,no)=>{server.once("error",no);server.listen(c.port,"127.0.0.1",ok);});
  await health?.report({event:"WORKER_RUNNING",role:"brand-web"});const timer=setInterval(()=>{void health?.flush();},5000);
  console.log(JSON.stringify({event:"BRAND_WEB_READY",url:`${origin}/v3-live.html`}));
  try{await runner.run(signal.signal);}finally{clearInterval(timer);await new Promise<void>(ok=>server.close(()=>ok()));await connection.close();await db.end();await health?.report({event:"WORKER_STOPPED"});}
}
main().catch(()=>{console.error(JSON.stringify({event:"BRAND_WEB_FAILED"}));process.exitCode=1;});
