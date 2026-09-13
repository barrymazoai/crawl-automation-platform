import {afterEach,expect,it} from "vitest";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DeploymentSchema} from "./deployment-supervisor.js";
import {serviceLabel,parseLaunchdList,renderService,independentReady} from "./deployment-launchd.js";
const roots:string[]=[];
const config=(root:string)=>DeploymentSchema.parse({platform:"darwin",host:"mini",root,node:"/usr/bin/node",jobs:[{id:"text",entry:root+"/text.js",env:{V3_WORKER_CONFIG:root+"/runtime.json"}}],resources:[],database:{connectionString:"postgres://test",tls:false}});
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
it("assigns distinct stable launchd services to each deployment, Worker and monitor",()=>{
 const a=config("/a"),b=config("/b");
 expect(new Set([serviceLabel(a),serviceLabel(a,"text"),serviceLabel(a,"vision"),serviceLabel(b,"text")]).size).toBe(4);
 expect(serviceLabel(a,"text")).toBe(serviceLabel({...a,root:"/a/."},"text"));
});
it("uses authoritative running launchd PIDs, excluding exited services and headers",()=>{
 const p=parseLaunchdList("PID\tStatus\tLabel\n321\t0\tworker\n-\t78\texited\n999\t-15\tother\n");
 expect([...p]).toEqual([["worker",321],["exited",undefined],["other",999]]);
});
it("each Worker plist launches only its entry; the separate monitor launches no Worker",()=>{
 const c=config("/private/a & b"),worker=renderService(c,"/private/manifest","/private/control",c.jobs[0]);
 expect(worker).toContain("/private/a &amp; b/text.js");expect(worker).toContain("V3_WORKER_HEALTH_FILE");
 expect(worker).not.toContain("/private/control");expect(worker).toContain("<key>KeepAlive</key><false/>");
 const monitor=renderService(c,"/private/manifest","/private/control");
 expect(monitor).toContain("<string>monitor</string>");expect(monitor).not.toContain("text.js");
});
it.each(["correct","stale-pid","exited-service","wrong-build","wrong-role","stale-heartbeat","stopped"])("independent readiness validates %s against launchd and runtime",async mode=>{
 const root=await mkdtemp(join(tmpdir(),"launchd-ready-"));roots.push(root);const c=config(root),j=c.jobs[0]!;
 await writeFile(j.env.V3_WORKER_CONFIG!,JSON.stringify({role:"text",expectedBuildId:"a".repeat(64)}),{mode:0o600});
 await writeFile(join(root,"text.health.json"),JSON.stringify({pid:mode==="stale-pid"?process.pid+1:process.pid,role:mode==="wrong-role"?"vision":"text",buildId:(mode==="wrong-build"?"b":"a").repeat(64),event:mode==="stopped"?"WORKER_STOPPED":"WORKER_RUNNING",reportedAt:new Date(Date.now()-(mode==="stale-heartbeat"?20000:0)).toISOString()}));
 expect(await independentReady(c,j,mode==="exited-service"?undefined:process.pid)).toBe(mode==="correct");
});
