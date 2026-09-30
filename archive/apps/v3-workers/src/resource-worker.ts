import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { ResourceRequestSchema } from "@crawl-automation/v3-contracts";
import { artifactBuildId, workerProcess, RoleRegistry } from "@crawl-automation/v3-worker-runtime";
import { PostgresResourceAdmission } from "../../../packages/v3-product/src/resource-admission.js";
import { CatalogDatabaseConfig } from "./catalog-config.js";
import { readGncPrivateJson } from "./gnc-config.js";
async function main() {
  if (process.env.V3_RESOURCE_ENABLED !== "true" || !process.env.V3_RESOURCE_CONFIG) throw Error("Resource opt-in required");
  const config = CatalogDatabaseConfig.parse(await readGncPrivateJson(process.env.V3_RESOURCE_CONFIG));
  const root = dirname(fileURLToPath(import.meta.url));
  const buildId = await artifactBuildId((await readdir(root)).filter(f=>f.endsWith(".js")).sort().map(f=>join(root,f)));
  await workerProcess(new RoleRegistry("business", [{role:"resource-admission",capability:"resource.admission",contractVersion:1,
    compatibility:"resource-v1",kind:"activity",buildId,testOnly:false,async prepare() {
      const db = new pg.Pool({connectionString:config.database.connectionString,ssl:config.database.tls?{rejectUnauthorized:true}:false,max:4,statement_timeout:5000,connectionTimeoutMillis:5000});
      try {
        await db.query("SELECT permit_id FROM resource_permit LIMIT 0");
        const module = new PostgresResourceAdmission(db);
        const execute = (method:"reserve"|"release") => async (raw:unknown) => {
          const context=Context.current(), input=ResourceRequestSchema.parse(raw), execution=context.info.workflowExecution;
          if (!execution || execution.workflowId!==input.workflowId || execution.runId!==input.runId)
            throw ApplicationFailure.nonRetryable("Resource caller identity mismatch","RESOURCE.IDENTITY_CONFLICT");
          context.cancellationSignal.throwIfAborted();
          try {return await module[method](input);} catch(e) {
            const code=e instanceof Error && /^RESOURCE\.[A-Z_]+$/.test(e.message)?e.message:"RESOURCE.UNAVAILABLE";
            throw ApplicationFailure.create({message:"Inspect resource ledger",type:code,nonRetryable:code!=="RESOURCE.UNAVAILABLE"});
          }
        };
        return {kind:"activity" as const,activities:{reserveResources:execute("reserve"),releaseResources:execute("release")},dispose:()=>db.end()};
      } catch(e) {await db.end();throw e;}
    }}]));
}
main().catch(()=>{console.error(JSON.stringify({event:"RESOURCE_WORKER_STARTUP_REJECTED"}));process.exitCode=1;});
