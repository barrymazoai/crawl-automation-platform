import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { RoleRegistry, artifactBuildId, workerProcess } from "@crawl-automation/v3-worker-runtime";
import { createR2Objects, R2ScopeSchema } from "@crawl-automation/v3-artifacts";
import { CodexTextConfigSchema } from "@crawl-automation/v3-text";
import { MultipartOcrConfigSchema } from "@crawl-automation/v3-ocr";
import { readGncPrivateJson } from "./gnc-config.js";
import { channelLabelRole, channelLabelRoutes } from "./channel-label-role.js";
import { runChannelLabelActivity } from "./channel-label-execution.js";

const database=z.strictObject({connectionString:z.string().min(1),tls:z.boolean()});
export const ChannelLabelWorkerConfigSchema=z.strictObject({
  root:z.string().refine(isAbsolute),storageId:z.string().min(1),database,resourceDatabase:database.optional(),
  r2:R2ScopeSchema,r2Credentials:z.strictObject({accessKeyId:z.string().min(1),secretAccessKey:z.string().min(1)}),
  codex:CodexTextConfigSchema.optional(),ocrProvider:MultipartOcrConfigSchema.optional(),
});
const routes=channelLabelRoutes;
async function main(){
  if(process.env.V3_CHANNEL_LABEL_ENABLED!=="true"||!process.env.V3_CHANNEL_LABEL_CONFIG)throw Error("Explicit private config required");
  const c=ChannelLabelWorkerConfigSchema.parse(await readGncPrivateJson(process.env.V3_CHANNEL_LABEL_CONFIG));
  const output=dirname(fileURLToPath(import.meta.url));
  const buildId=await artifactBuildId((await readdir(output)).filter(n=>n.endsWith(".js")).sort().map(n=>join(output,n)));
  await workerProcess(new RoleRegistry("business",Object.entries(routes).map(([role,names])=>({
    role:`channel-label-${role}`,capability:`channel.label.${role}`,compatibility:"channel-label-v1",contractVersion:1,
    kind:"activity" as const,testOnly:false,buildId,sessionScoped:true as const,
    async prepare(runtime){
      const pool=(d:z.infer<typeof database>)=>new pg.Pool({connectionString:d.connectionString,ssl:d.tls?{rejectUnauthorized:true}:false,max:2,connectionTimeoutMillis:5000,statement_timeout:5000});
      const db=pool(c.database),resourceDb=role==="resources"&&c.resourceDatabase?pool(c.resourceDatabase):db,r2=createR2Objects(c.r2,c.r2Credentials);
      let modules:Awaited<ReturnType<typeof channelLabelRole>>|undefined;
      const dispose=async()=>{await modules?.close();r2.close();if(resourceDb!==db)await resourceDb.end();await db.end();};
      try{
        await db.query("SELECT review_id FROM review_record LIMIT 0");
        modules=await channelLabelRole({root:join(c.root,role),db,resourceDb,remote:r2.store,storageId:c.storageId,
          ...(c.codex?{codex:c.codex}:{}),...(c.ocrProvider?{ocrProvider:c.ocrProvider}:{}),role,hostId:runtime.hostId});
        await modules.check();
        console.log(JSON.stringify({event:"CHANNEL_ROLE_PREPARED",role,hostId:runtime.hostId,modules:modules.constructed}));
        const owned=modules;
        return{kind:"activity" as const,dispose,activities:Object.fromEntries(names.map(name=>[name,async(raw:unknown)=>
          runChannelLabelActivity(name,raw,owned.stops,owned.activities[name]!)]))};
      }catch(error){await dispose();throw error;}
    },
  }))));
}
main().catch(()=>{console.error(JSON.stringify({event:"CHANNEL_LABEL_STARTUP_REJECTED"}));process.exitCode=1;});
