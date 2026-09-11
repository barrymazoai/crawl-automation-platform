// Explicit, loopback-only, read-only acceptance UI. Never enable submission or model work here.
import { readFile, lstat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname } from "node:path";
import { z } from "zod";
import pg from "pg";
import { createApp } from "./http/app.js";
import { PostgresBrands } from "./storage/postgres-brands.js";
import { PostgresDashboard } from "./storage/postgres-dashboard.js";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { V3DatabaseUrl } from "./bootstrap/config.js";
const [configPath, webRoot] = process.argv.slice(2);
const schema = z.strictObject({ databaseUrl: V3DatabaseUrl, token: z.string().min(32), ui: z.array(z.strictObject({ clusterId:z.string(),baseUrl:z.url() })),port:z.number().int().min(1024).max(65535),dataset:z.string().max(300) });
async function main() {
  if(!configPath || !webRoot)throw Error("Explicit private config and built web directory required");
  const stat=await lstat(configPath);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error("Private config permissions required");
  const config=schema.parse(JSON.parse(await readFile(configPath,"utf8"))), origin=`http://127.0.0.1:${config.port}`;
  const db=new pg.Pool({connectionString:config.databaseUrl,options:"-c default_transaction_read_only=on",max:4,statement_timeout:5000});
  const app=createApp(new PostgresBrands(db),config.token,{dashboard:new PostgresDashboard(db,config.ui),reviews:new PostgresReviews(db)});
  const html=(await readFile(resolve(webRoot,"v3-live.html"),"utf8")).replace("</head>",`<meta name="v3-dataset" content="${config.dataset.replace(/[&"<>]/g,c=>({"&":"&amp;",'"':"&quot;","<":"&lt;",">":"&gt;"}[c]!))}"></head>`);
  const server=createServer(async(req,res)=>{
    try{
      res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");
      const deny=(status=403)=>{res.writeHead(status);res.end();};
      if(req.headers.host!==`127.0.0.1:${config.port}` || req.method!=="GET" || (req.headers.origin&&req.headers.origin!==origin))return deny();
      const url=new URL(req.url!,origin);
      if(url.pathname.startsWith("/api/")){
        if(req.headers["x-v3-client"]!=="local-workspace" || (req.headers["sec-fetch-site"]&&req.headers["sec-fetch-site"]!=="same-origin"))return deny();
        if(!/^\/api\/v3\/(dashboard(?:\/products)?|reviews(?:\/[A-Za-z0-9_-]+)?)$/.test(url.pathname))return deny();
        const r=await app.request(url.pathname+url.search,{headers:{authorization:`Bearer ${config.token}`}});
        res.writeHead(r.status,{"Content-Type":"application/json"});res.end(await r.text());return;
      }
      if(url.pathname==="/"||url.pathname==="/v3-live.html"){res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});res.end(html);return;}
      if(!/^\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2?)$/.test(url.pathname))return deny(404);
      const type=extname(url.pathname)===".js"?"text/javascript":extname(url.pathname)===".css"?"text/css":"font/woff2";
      const bytes=await readFile(resolve(webRoot,`.${url.pathname}`));res.writeHead(200,{"Content-Type":type});res.end(bytes);
    }catch{res.writeHead(503,{"Content-Type":"application/json"});res.end(JSON.stringify({error:{code:"PREVIEW_UNAVAILABLE",message:"Read-only preview unavailable"}}));}
  });
  server.listen(config.port,"127.0.0.1",()=>console.log(JSON.stringify({event:"DASHBOARD_READONLY_READY",url:`${origin}/v3-live.html?view=dashboard`})));
  const stop=()=>server.close(()=>void db.end());process.once("SIGINT",stop);process.once("SIGTERM",stop);
}
main().catch(()=>{console.error("DASHBOARD_PREVIEW_STARTUP_FAILED");process.exitCode=1;});
